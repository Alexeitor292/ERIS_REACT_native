import AVFoundation
import ERISKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A photo or video on the report screen. It waits in a temporary file, so a few
/// long videos don't sit in memory, until the report is filed.
struct ReportMedia: Identifiable {
    let id = UUID()
    let kind: IncidentAttachmentKind
    let file: URL
    let mimeType: String
    let thumbnail: UIImage?
    /// "0:12 · 14.2 MB" for a video, the size for a photo.
    let detail: String

    var isVideo: Bool { kind == .video }

    func discard() { try? FileManager.default.removeItem(at: file) }
}

/// Turns what the camera or library gave into something every browser can show:
/// photos as JPEG, videos as 720p MP4 (iPhone video is usually HEVC, which many
/// Windows browsers can't play, and this keeps it under the upload limit).
enum ReportMediaFiles {
    static let limit = 10
    /// A recording stops here: at 720p that stays under the upload limit.
    static let maxRecordingSeconds: TimeInterval = 120

    private static var folder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ERISReportMedia", isDirectory: true)
    }

    private static func newFile(_ ext: String) throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("\(UUID().uuidString).\(ext)")
    }

    /// Whatever an earlier report left behind.
    static func clearLeftovers() { try? FileManager.default.removeItem(at: folder) }

    private static func size(of url: URL) -> Int {
        (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    }

    static func photo(_ image: UIImage) throws -> ReportMedia {
        guard let jpeg = image.jpegData(compressionQuality: 0.9) else { throw Problem(message: "The photo could not be read.") }
        let file = try newFile("jpg")
        try jpeg.write(to: file)
        return ReportMedia(kind: .photo, file: file, mimeType: "image/jpeg",
                           thumbnail: image.preparingThumbnail(of: CGSize(width: 180, height: 180)),
                           detail: SubmissionLibrary.sizeText(jpeg.count) ?? "")
    }

    /// Takes over `source`: it is gone afterwards.
    static func video(from source: URL) async throws -> ReportMedia {
        defer { try? FileManager.default.removeItem(at: source) }
        let target = try newFile("mp4")
        let converted = await convert(source, to: target)
        let file: URL
        let mimeType: String
        if converted {
            file = target
            mimeType = "video/mp4"
        } else {
            // Better the original than nothing: it still plays on iPhones and Macs.
            let ext = source.pathExtension.isEmpty ? "mov" : source.pathExtension
            file = try newFile(ext)
            try FileManager.default.copyItem(at: source, to: file)
            mimeType = UTType(filenameExtension: ext)?.preferredMIMEType ?? "video/quicktime"
        }
        let bytes = size(of: file)
        if let problem = SubmissionLibrary.sizeProblem(fileName: "That video", bytes: bytes) {
            try? FileManager.default.removeItem(at: file)
            throw Problem(message: problem)
        }
        let asset = AVURLAsset(url: file)
        let seconds = (try? await asset.load(.duration)).map(CMTimeGetSeconds) ?? 0
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 180, height: 180)
        let frame = try? await generator.image(at: .zero).image
        return ReportMedia(kind: .video, file: file, mimeType: mimeType, thumbnail: frame.map(UIImage.init(cgImage:)),
                           detail: [clock(seconds), SubmissionLibrary.sizeText(bytes)].compactMap { $0 }.joined(separator: " · "))
    }

    /// A photo or video chosen in the library.
    static func fromLibrary(_ item: PhotosPickerItem) async throws -> ReportMedia? {
        if item.isVideo {
            guard let movie = try await item.loadTransferable(type: PickedMovie.self) else { return nil }
            return try await video(from: movie.url)
        }
        guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { return nil }
        return try photo(image)
    }

    private static func convert(_ source: URL, to target: URL) async -> Bool {
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: source), presetName: AVAssetExportPreset1280x720) else {
            return false
        }
        session.outputURL = target
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { done.resume() }
        }
        return session.status == .completed
    }

    private static func clock(_ seconds: Double) -> String? {
        guard seconds.isFinite, seconds > 0 else { return nil }
        let whole = Int(seconds.rounded())
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }

    struct Problem: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}

/// What the Take Photo and Record Video buttons open.
enum ReportCapture: String, Identifiable {
    case photo, video
    var id: String { rawValue }

    /// Tests run where there is no camera, so the demo stands in for one.
    static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) || DemoServer.isEnabled }
    static var isDemo: Bool { !UIImagePickerController.isSourceTypeAvailable(.camera) }
}

/// The iPhone's own camera, in one mode.
struct SystemCamera: UIViewControllerRepresentable {
    enum Taken {
        case photo(UIImage)
        case video(URL)
    }

    let mode: ReportCapture
    /// Nil when cancelled.
    let done: (Taken?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        switch mode {
        case .photo:
            picker.mediaTypes = [UTType.image.identifier]
            picker.cameraCaptureMode = .photo
        case .video:
            picker.mediaTypes = [UTType.movie.identifier]
            picker.cameraCaptureMode = .video
            picker.videoQuality = .typeHigh
            picker.videoMaximumDuration = ReportMediaFiles.maxRecordingSeconds
        }
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (Taken?) -> Void

        init(done: @escaping (Taken?) -> Void) { self.done = done }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                done(.photo(image))
            } else if let movie = info[.mediaURL] as? URL, let kept = keep(movie) {
                done(.video(kept))
            } else {
                done(nil)
            }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }

        /// The camera deletes its file once it closes.
        private func keep(_ movie: URL) -> URL? {
            let kept = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(UUID().uuidString).\(movie.pathExtension)")
            return (try? FileManager.default.copyItem(at: movie, to: kept)) == nil ? nil : kept
        }
    }
}

/// One photo or video on the report: what it is, and how to take it off.
struct ReportMediaRow: View {
    let media: ReportMedia
    let title: String
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                if let thumbnail = media.thumbnail {
                    Image(uiImage: thumbnail).resizable().scaledToFill()
                } else {
                    Color.secondary.opacity(0.2)
                }
                if media.isVideo {
                    Image(systemName: "play.circle.fill").font(.title2)
                        .foregroundStyle(.white).shadow(radius: 2)
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(media.detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            // Borderless, so only this takes the tap, not the whole row.
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill").font(.title2).foregroundStyle(Color(.systemGray))
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Remove \(title)")
        }
    }
}
