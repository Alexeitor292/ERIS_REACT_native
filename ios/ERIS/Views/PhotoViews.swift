import AVFoundation
import ERISKit
import PhotosUI
import SwiftUI

// MARK: - Section photos

/// What a form section needs to show and add its photos; set once by the
/// editor and read by each section.
struct GisaPhotoContext {
    var detail: SubmissionDetail?
    var canEdit = false
    var busySection: String?
    var add: (String, GisaPhotoSource) -> Void = { _, _ in }
    var open: (AttachmentRef) -> Void = { _ in }
}

enum GisaPhotoSource {
    case camera, library
}

private struct GisaPhotoContextKey: EnvironmentKey {
    static let defaultValue = GisaPhotoContext()
}

extension EnvironmentValues {
    var gisaPhotos: GisaPhotoContext {
        get { self[GisaPhotoContextKey.self] }
        set { self[GisaPhotoContextKey.self] = newValue }
    }
}

/// A section's photos and its Add Photo button, as the Expo editor's
/// renderTaggedSectionMedia: each photo is filed under its form section.
struct GisaSectionPhotos: View {
    @Environment(\.gisaPhotos) private var photos
    let sectionKey: String

    var body: some View {
        let attached = photos.detail.map { GisaPhotoSections.photos(in: sectionKey, of: $0) } ?? []
        VStack(alignment: .leading, spacing: 8) {
            if !attached.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(attached) { attachment in
                            // Borderless, so each control in this list row takes its own taps.
                            Button { photos.open(attachment) } label: { AttachmentThumbnail(attachment: attachment) }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("Photo \(attachment.fileName ?? "")")
                        }
                    }
                }
            }
            if photos.canEdit {
                if photos.busySection == sectionKey {
                    ProgressView("Uploading photo…")
                } else {
                    Menu {
                        Button { photos.add(sectionKey, .camera) } label: { Label("Take Photo", systemImage: "camera") }
                        Button { photos.add(sectionKey, .library) } label: {
                            Label("Choose from Library", systemImage: "photo.on.rectangle")
                        }
                    } label: {
                        // The whole row opens the menu, not just its words.
                        Label("Add Photo", systemImage: "camera.badge.ellipsis")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .disabled(photos.busySection != nil)
                }
            }
        }
    }
}

// MARK: - Camera

/// Full-screen camera that records the location and the camera's direction.
struct MappedCameraScreen: View {
    @StateObject private var camera = MappedCamera()
    let onCaptured: (MappedPhotoCapture) -> Void
    let onCancel: () -> Void
    @State private var failure: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let message = camera.unavailable {
                VStack(spacing: 16) {
                    Image(systemName: "camera.fill").font(.largeTitle)
                    Text(message).multilineTextAlignment(.center)
                    Button("Close", action: onCancel).buttonStyle(.borderedProminent)
                }
                .foregroundStyle(.white)
                .padding()
            } else {
                CameraPreview(session: camera.session).ignoresSafeArea()
                VStack {
                    HStack(alignment: .top) {
                        Button("Cancel", action: onCancel).buttonStyle(.bordered).tint(.white)
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(camera.locationLabel)
                            Text(camera.directionLabel)
                        }
                        .font(.caption.weight(.semibold))
                        .padding(8)
                        .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                        .foregroundStyle(.white)
                    }
                    .padding()
                    Spacer()
                    Button {
                        Task {
                            do { onCaptured(try await camera.capture()) } catch { failure = error.localizedDescription }
                        }
                    } label: {
                        Circle().strokeBorder(.white, lineWidth: 4)
                            .background(Circle().fill(.white.opacity(camera.capturing ? 0.3 : 0.9)).padding(6))
                            .frame(width: 76, height: 76)
                    }
                    .disabled(!camera.ready || camera.capturing)
                    .accessibilityLabel("Take mapped photo")
                    .padding(.bottom, 24)
                }
            }
        }
        .task { await camera.start() }
        .onDisappear { camera.stop() }
        .alert("Camera failed", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}
}

/// A library photo as a JPEG (the web portal cannot show HEIC) and what its
/// EXIF says about where and which way it was taken.
enum LibraryPhoto {
    static func load(_ item: PhotosPickerItem) async throws -> MappedPhotoCapture? {
        guard let data = try await item.loadTransferable(type: Data.self) else { return nil }
        let exif = PhotoExif.flattened(imageData: data)
        guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) else { return nil }
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        return MappedPhotoCapture(jpeg: jpeg, fileName: "library-photo-\(stamp).jpg",
                                  metadata: PhotoCapture.metadata(exif: exif, assetId: item.itemIdentifier))
    }
}

// MARK: - One photo

/// A photo with where and which way it was taken, and, for those allowed,
/// a correction of either. Dragging the photo on a map comes with the ArcGIS
/// Site Photo Map; here the values are typed.
struct PhotoDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let submissionId: Int
    let attachment: AttachmentRef
    @State private var photo: MappedPhoto?
    @State private var error: String?
    @State private var correcting = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    AsyncImage(url: photo?.downloadUrl.flatMap(URL.init(string:))) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        Color.gray.opacity(0.15).aspectRatio(4 / 3, contentMode: .fit).overlay(ProgressView())
                    }
                    .listRowInsets(EdgeInsets())
                }
                if let photo {
                    Section("Where it was taken") {
                        if let section = photo.sectionKey,
                           let label = GisaPhotoSections.all.first(where: { $0.key == section })?.label {
                            LabeledContent("Section", value: label)
                        }
                        if let taken = ServerDate.display(photo.capturedAt) { LabeledContent("Taken", value: taken) }
                        LabeledContent("Location", value: photo.locationText ?? "Not recorded")
                        HStack {
                            LabeledContent("Direction", value: photo.directionText ?? "Not recorded")
                            if let heading = photo.cameraHeadingDeg {
                                Image(systemName: "location.north.fill")
                                    .rotationEffect(.degrees(heading))
                                    .foregroundStyle(.tint)
                                    .accessibilityHidden(true)
                            }
                        }
                        if !photo.sourceText.isEmpty {
                            Text(photo.sourceText).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if photo.canEditCorrection == true {
                        Section {
                            Button("Correct Location or Direction") { correcting = true }
                        } footer: {
                            Text("The original values stay on record; a correction is added on top.")
                        }
                    }
                } else if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle(attachment.fileName ?? "Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .task { await load() }
            .sheet(isPresented: $correcting) {
                if let photo {
                    PhotoCorrectionForm(submissionId: submissionId, photo: photo) { Task { await load() } }
                }
            }
        }
    }

    private func load() async {
        do {
            let map = try await SubmissionsAPI(api: model.api).photoMap(submissionId)
            photo = map.photos.first { $0.attachmentId == attachment.id }
            error = photo == nil ? "This photo is not on the form's photo map." : nil
        } catch {
            self.error = model.handle(error)
        }
    }
}

/// Typed corrections of a photo's location and direction.
struct PhotoCorrectionForm: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let submissionId: Int
    let photo: MappedPhoto
    let saved: () -> Void
    @State private var correctLocation = false
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var correctDirection = false
    @State private var heading = 0.0
    @State private var problem: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Correct the direction", isOn: $correctDirection)
                    if correctDirection {
                        HStack {
                            Text("Facing \(Int(heading.rounded()) % 360)° (\(PhotoCapture.compassPoint(heading.rounded())))")
                            Spacer()
                            Image(systemName: "location.north.fill").rotationEffect(.degrees(heading)).foregroundStyle(.tint)
                        }
                        Slider(value: $heading, in: 0...359, step: 1) { Text("Direction") }
                    }
                } footer: {
                    Text("Degrees clockwise from true north, the way the camera was pointing.")
                }
                Section {
                    Toggle("Correct the location", isOn: $correctLocation)
                    if correctLocation {
                        TextField("Latitude", text: $latitude).keyboardType(.numbersAndPunctuation)
                        TextField("Longitude", text: $longitude).keyboardType(.numbersAndPunctuation)
                    }
                }
                if let problem { Text(problem).foregroundStyle(.red) }
            }
            .navigationTitle("Correct Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(saving)
                }
            }
            .onAppear {
                let correction = photo.correction
                correctDirection = correction?.headingOverridden == true
                heading = correction?.headingOverrideDeg ?? photo.cameraHeadingDeg ?? 0
                correctLocation = correction?.locationOverridden == true
                latitude = (correction?.locationOverride?.latitude ?? photo.latitude).map { String(format: "%.6f", $0) } ?? ""
                longitude = (correction?.locationOverride?.longitude ?? photo.longitude).map { String(format: "%.6f", $0) } ?? ""
            }
        }
    }

    private func save() async {
        var location: PhotoCorrection.Location?
        if correctLocation {
            guard let lat = Double(latitude.trimmingCharacters(in: .whitespaces)),
                  let lon = Double(longitude.trimmingCharacters(in: .whitespaces)),
                  (-90...90).contains(lat), (-180...180).contains(lon) else {
                problem = "Enter a latitude from -90 to 90 and a longitude from -180 to 180."
                return
            }
            location = .init(latitude: lat, longitude: lon)
        }
        saving = true
        defer { saving = false }
        do {
            try await SubmissionsAPI(api: model.api).correctPhoto(
                submissionId, attachmentId: photo.attachmentId,
                // Whole degrees, as shown; 360 is north again.
                PhotoCorrection(locationOverride: location,
                                headingOverrideDeg: correctDirection ? heading.rounded().truncatingRemainder(dividingBy: 360) : nil))
            saved()
            dismiss()
        } catch {
            problem = model.handle(error)
        }
    }
}
