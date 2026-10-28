// AVCaptureSession predates Swift concurrency; Apple documents starting and
// stopping it off the main thread, as done here.
@preconcurrency import AVFoundation
import CoreLocation
import CoreMotion
import ERISKit
import ImageIO
import UIKit

/// A field photo and where and which way it was taken.
struct MappedPhotoCapture {
    let jpeg: Data
    let fileName: String
    let metadata: PhotoCaptureMetadata?
}

/// The rear camera, GPS and the camera's compass direction together, as the
/// Expo MappedPhotoCamera and ErisCameraDirection module did. The rules for
/// what is recorded are in ERISKit (PhotoCapture).
@MainActor
final class MappedCamera: NSObject, ObservableObject {
    @Published private(set) var locationLabel = "GPS acquiring…"
    @Published private(set) var directionLabel = "Camera direction acquiring…"
    @Published private(set) var ready = false
    @Published private(set) var capturing = false
    /// Why the camera cannot be used, when it cannot.
    @Published private(set) var unavailable: String?

    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let locations = CLLocationManager()
    private let motion = CMMotionManager()
    private var positions: [PositionSample] = []
    private var labelTimer: Timer?
    private var pending: CheckedContinuation<(Data, [String: Any]), Error>?
    private let sessionQueue = DispatchQueue(label: "gov.ca.dot.eris.camera")

    private static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    func start() async {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            unavailable = "This device has no rear camera. Choose a photo from the library instead."
            return
        }
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            unavailable = "ERIS needs the camera to capture mapped field evidence. Allow it in Settings → ERIS."
            return
        }
        do {
            let input = try AVCaptureDeviceInput(device: camera)
            session.beginConfiguration()
            session.sessionPreset = .photo
            if session.canAddInput(input) { session.addInput(input) }
            if session.canAddOutput(output) { session.addOutput(output) }
            session.commitConfiguration()
        } catch {
            unavailable = "The camera could not be opened."
            return
        }
        let session = session
        sessionQueue.async { session.startRunning() }
        ready = true
        startLocation()
        startDirection()
        labelTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshLabels() }
        }
    }

    func stop() {
        labelTimer?.invalidate()
        labelTimer = nil
        locations.stopUpdatingLocation()
        motion.stopDeviceMotionUpdates()
        let session = session
        sessionQueue.async { session.stopRunning() }
        ready = false
    }

    private func startLocation() {
        locations.delegate = self
        locations.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locations.distanceFilter = kCLDistanceFilterNone
        if locations.authorizationStatus == .notDetermined { locations.requestWhenInUseAuthorization() }
        if [.denied, .restricted].contains(locations.authorizationStatus) {
            locationLabel = "GPS unavailable • photo may be unmapped"
        }
        locations.startUpdatingLocation()
    }

    private func startDirection() {
        guard motion.isDeviceMotionAvailable,
              CMMotionManager.availableAttitudeReferenceFrames().contains(.xTrueNorthZVertical) else {
            directionLabel = "Camera direction unavailable"
            return
        }
        motion.deviceMotionUpdateInterval = 1.0 / 30.0
        // Lets iOS show its compass calibration prompt when needed.
        motion.showsDeviceMovementDisplay = true
        motion.startDeviceMotionUpdates(using: .xTrueNorthZVertical)
    }

    /// The rear camera's direction now, from the latest Core Motion sample.
    private func currentDirection() -> CameraDirectionSample? {
        guard let sample = motion.deviceMotion else { return nil }
        let r = sample.attitude.rotationMatrix
        let accuracy: Int
        switch sample.magneticField.accuracy {
        case .high: accuracy = 3
        case .medium: accuracy = 2
        case .low: accuracy = 1
        default: accuracy = 0
        }
        let age = ProcessInfo.processInfo.systemUptime - sample.timestamp
        return try? PhotoCapture.cameraDirection(m31: r.m31, m32: r.m32, m33: r.m33, ageSeconds: age,
                                                 accuracyCode: accuracy).get()
    }

    private func refreshLabels() {
        if motion.isDeviceMotionActive { directionLabel = PhotoCapture.directionLabel(currentDirection()) }
        if ![.denied, .restricted].contains(locations.authorizationStatus) {
            locationLabel = PhotoCapture.locationLabel(PhotoCapture.bestPosition(positions, atMs: Self.nowMs))
        }
    }

    /// Takes the photo and records the best fix and the direction at the shutter.
    func capture() async throws -> MappedPhotoCapture {
        capturing = true
        defer { capturing = false }
        let shutterMs = Self.nowMs
        let capturedAt = ISO8601DateFormatter.withFractionalSeconds.string(from: Date(timeIntervalSince1970: shutterMs / 1000))
        let position = PhotoCapture.bestPosition(positions, atMs: shutterMs)
        let direction = PhotoCapture.recordable(currentDirection())
        let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
        let (jpeg, properties) = try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            output.capturePhoto(with: settings, delegate: self)
        }
        let measured = PhotoCapture.metadata(capturedAt: capturedAt, position: position, direction: direction)
        let fromFile = PhotoCapture.metadata(exif: PhotoExif.flattened(properties), assetId: nil)
        return MappedPhotoCapture(jpeg: jpeg, fileName: "field-photo-\(Int(shutterMs)).jpg",
                                  metadata: PhotoCapture.merge(measured, fromFile))
    }
}

extension MappedCamera: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations updates: [CLLocation]) {
        let samples = updates.map {
            PositionSample(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude,
                           accuracy: $0.horizontalAccuracy >= 0 ? $0.horizontalAccuracy : nil,
                           altitude: $0.verticalAccuracy >= 0 ? $0.altitude : nil, observedAtMs: 0)
        }
        Task { @MainActor in
            for sample in samples {
                let arrived = PositionSample(latitude: sample.latitude, longitude: sample.longitude,
                                             accuracy: sample.accuracy, altitude: sample.altitude, observedAtMs: Self.nowMs)
                self.positions = PhotoCapture.recording(arrived, into: self.positions)
            }
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            if [.denied, .restricted].contains(manager.authorizationStatus) {
                self.locationLabel = "GPS unavailable • photo may be unmapped"
            }
        }
    }
}

extension MappedCamera: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto,
                                 error: Error?) {
        let data = photo.fileDataRepresentation()
        let properties = photo.metadata
        Task { @MainActor in
            if let data, error == nil {
                self.pending?.resume(returning: (data, properties))
            } else {
                self.pending?.resume(throwing: error ?? CaptureFailure.noImage)
            }
            self.pending = nil
        }
    }

    enum CaptureFailure: LocalizedError {
        case noImage
        var errorDescription: String? { "The camera did not return an image." }
    }
}

/// A photo file's EXIF as the flattened keys the capture rules read
/// (GPSLatitude, GPSImgDirection, DateTimeOriginal…).
enum PhotoExif {
    static func flattened(_ properties: [String: Any]) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        if let gps = properties[kCGImagePropertyGPSDictionary as String] as? [String: Any] {
            for (key, value) in gps { out["GPS\(key)"] = json(value) }
        }
        if let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any],
           let original = exif[kCGImagePropertyExifDateTimeOriginal as String] {
            out["DateTimeOriginal"] = json(original)
        }
        if let tiff = properties[kCGImagePropertyTIFFDictionary as String] as? [String: Any],
           let date = tiff[kCGImagePropertyTIFFDateTime as String] {
            out["DateTime"] = json(date)
        }
        return out
    }

    static func flattened(imageData: Data) -> [String: JSONValue] {
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else { return [:] }
        return flattened(properties)
    }

    private static func json(_ value: Any) -> JSONValue {
        switch value {
        case let number as NSNumber: return .number(number.doubleValue)
        case let text as String: return .string(text)
        case let list as [Any]: return .array(list.map(json))
        default: return .string(String(describing: value))
        }
    }
}

extension ISO8601DateFormatter {
    /// "2026-10-28T19:01:10.123Z", as JavaScript's toISOString writes it.
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
