import ERISKit
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// Where a file added from the Gallery comes from.
enum GalleryAddSource {
    case camera, library, files
}

/// Step 5, Gallery: every file on the form, as the web's Submission library
/// (photos, videos, documents and sketches, each with its section), and
/// adding photos, videos and documents (PDF, CAD, Office) as the Expo
/// editor's Upload Media / File did.
struct GisaLibrarySection: View {
    let detail: SubmissionDetail
    let canEdit: Bool
    /// "Uploading 1 of 3…" while files are being sent.
    let uploading: String?
    /// The file being fetched to open.
    let opening: Int?
    let add: (GalleryAddSource) -> Void
    let open: (SubmissionLibrary.Item) -> Void
    @State private var filter = SubmissionLibrary.Filter.all

    var body: some View {
        let items = SubmissionLibrary.items(of: detail)
        let counts = SubmissionLibrary.counts(items)
        let shown = SubmissionLibrary.filter(items, filter)
        Section {
            if !items.isEmpty {
                Picker("Show", selection: $filter) {
                    ForEach(SubmissionLibrary.Filter.allCases) { option in
                        // "Documents" does not fit four to a row on a phone.
                        Text("\(option == .documents ? "Docs" : option.rawValue) \(counts.count(option))").tag(option)
                    }
                }
                .pickerStyle(.segmented)
            }
            if shown.isEmpty {
                Text(items.isEmpty ? "No files are attached to this submission yet." : "No files match this filter.")
                    .foregroundStyle(.secondary)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 10)], spacing: 12) {
                    ForEach(shown) { item in
                        Button { open(item) } label: { FileTile(item: item, opening: opening == item.id) }
                            .buttonStyle(.borderless)
                            .disabled(opening != nil)
                            .accessibilityLabel("\(item.fileName), \(item.sectionLabel)")
                            .accessibilityIdentifier("file-\(item.id)")
                    }
                }
                .padding(.vertical, 4)
            }
            if canEdit {
                if let uploading {
                    ProgressView(uploading)
                } else {
                    Menu {
                        Button { add(.camera) } label: { Label("Take Photo", systemImage: "camera") }
                        Button { add(.library) } label: { Label("Photo or Video Library", systemImage: "photo.on.rectangle") }
                        Button { add(.files) } label: { Label("Files (PDF, CAD, documents)", systemImage: "folder") }
                    } label: {
                        Label("Add Files", systemImage: "plus.circle")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("add-file")
                }
            }
        } header: {
            Text("Submission Library")
        } footer: {
            Text(canEdit
                 ? "\(SubmissionLibrary.countLabel(counts)). Files added here belong to the whole submission; photos for a section are added in that section. Up to \(SubmissionLibrary.maxUploadMB) MB each."
                 : SubmissionLibrary.countLabel(counts))
        }
    }
}

/// A file in the library: its picture, or an icon for its type.
private struct FileTile: View {
    let item: SubmissionLibrary.Item
    let opening: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ZStack {
                if item.media == .photo {
                    AttachmentThumbnail(attachment: item.attachment, size: CGSize(width: 100, height: 76))
                } else {
                    RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.15)).frame(height: 76)
                        .overlay(Image(systemName: icon).font(.title2).foregroundStyle(.secondary))
                }
                if opening { ProgressView().padding(6).background(.thinMaterial, in: Circle()) }
            }
            .frame(maxWidth: .infinity)
            Text(item.fileName).font(.caption2).lineLimit(1).foregroundStyle(.primary)
            Text(item.sectionLabel).font(.caption2).lineLimit(1).foregroundStyle(.secondary)
        }
    }

    private var icon: String {
        switch item.media {
        case .video: return "film"
        case .photo: return "photo"
        case .document:
            return SubmissionLibrary.isPDF(mimeType: item.attachment.mimeType, fileName: item.attachment.fileName)
                ? "doc.richtext" : "doc"
        }
    }
}

// MARK: - Opening and adding files

enum FileTransfer {
    /// A form file as a local copy under its own name, for Quick Look (which
    /// shows PDFs, Office files, videos and pictures). The presigned link is
    /// fetched without the ERIS session token.
    static func localCopy(of attachment: AttachmentRef, api: APIClient) async throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ERISFiles/\(attachment.id)", isDirectory: true)
        let name = (attachment.fileName?.isEmpty == false ? attachment.fileName! : "attachment-\(attachment.id)")
            .replacingOccurrences(of: "/", with: "-")
        let target = folder.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: target.path) { return target }
        let link = try await SubmissionsAPI(api: api).attachmentLink(attachment.id)
        guard let url = URL(string: link.downloadUrl) else { throw URLError(.badURL) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if url.scheme == "data" {
            let (data, _) = try await URLSession.shared.data(from: url)
            try data.write(to: target)
        } else {
            let (downloaded, response) = try await URLSession.shared.download(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw URLError(.badServerResponse)
            }
            try FileManager.default.moveItem(at: downloaded, to: target)
        }
        return target
    }

    /// A file to upload: its bytes, name and type.
    struct Upload {
        let data: Data
        let fileName: String
        let mimeType: String
    }

    /// A file chosen in Files, read while access is granted. HEIC pictures
    /// become JPEG, which the web portal can show; anything else is sent as it is.
    static func upload(fromFile url: URL) throws -> Upload {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if let problem = SubmissionLibrary.sizeProblem(fileName: url.lastPathComponent, bytes: size) {
            throw UploadProblem(message: problem)
        }
        let data = try Data(contentsOf: url)
        let type = UTType(filenameExtension: url.pathExtension)
        if let type, type.conforms(to: .heic) || type.conforms(to: .heif),
           let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) {
            return Upload(data: jpeg, fileName: url.deletingPathExtension().lastPathComponent + ".jpg", mimeType: "image/jpeg")
        }
        return Upload(data: data, fileName: url.lastPathComponent, mimeType: type?.preferredMIMEType ?? "application/octet-stream")
    }

    /// A video from the photo library, as the file Photos exports.
    static func upload(fromVideo item: PhotosPickerItem) async throws -> Upload? {
        guard let movie = try await item.loadTransferable(type: PickedMovie.self) else { return nil }
        defer { try? FileManager.default.removeItem(at: movie.url) }
        let size = (try? movie.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if let problem = SubmissionLibrary.sizeProblem(fileName: movie.url.lastPathComponent, bytes: size) {
            throw UploadProblem(message: problem)
        }
        let type = UTType(filenameExtension: movie.url.pathExtension)
        return Upload(data: try Data(contentsOf: movie.url), fileName: movie.url.lastPathComponent,
                      mimeType: type?.preferredMIMEType ?? "video/quicktime")
    }

    struct UploadProblem: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}

/// A picked video, copied out of Photos to a file of its own.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ERISUploads", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let target = folder.appendingPathComponent("\(UUID().uuidString)-\(received.file.lastPathComponent)")
            try FileManager.default.copyItem(at: received.file, to: target)
            return PickedMovie(url: target)
        }
    }
}

extension PhotosPickerItem {
    var isVideo: Bool { supportedContentTypes.contains { $0.conforms(to: .movie) } }
}
