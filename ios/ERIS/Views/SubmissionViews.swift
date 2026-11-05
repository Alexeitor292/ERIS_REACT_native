import ERISKit
import SwiftUI

/// Distinct from incident ids in the navigation path.
struct SubmissionRoute: Hashable {
    let id: Int
}

/// A photo from its presigned link. The link carries its own signature, so it
/// is fetched without the ERIS session token.
struct AttachmentThumbnail: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var offline: OfflineSync
    let attachment: AttachmentRef
    var size = CGSize(width: 120, height: 90)
    @State private var url: URL?
    /// Kept on this iPhone with the work assigned (AssignedWork).
    @State private var kept: UIImage?

    var body: some View {
        Group {
            if let kept {
                Image(uiImage: kept).resizable().scaledToFill()
            } else {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Color.gray.opacity(0.15)
                }
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task {
            if let data = offline.store.file(attachment.id), let image = UIImage(data: data) {
                kept = image
            } else if let link = try? await SubmissionsAPI(api: model.api).attachmentLink(attachment.id) {
                url = URL(string: link.downloadUrl)
            }
        }
    }
}

/// Not connected, and what is waiting to send, with a way to send it now.
struct OfflineStatusSection: View {
    @EnvironmentObject private var offline: OfflineSync
    /// When what is shown was kept, if it was.
    let keptAt: Date?

    var body: some View {
        if keptAt != nil || !offline.waiting.isEmpty {
            Section {
                if let keptAt {
                    Label("ERIS can't be reached. Showing what this iPhone kept \(keptAt.formatted(.relative(presentation: .named))).",
                          systemImage: "wifi.slash")
                        .font(.subheadline)
                }
                if let summary = offline.waiting.summary {
                    HStack {
                        Label(summary, systemImage: "arrow.up.circle").font(.subheadline)
                        Spacer()
                        if offline.sending {
                            ProgressView()
                        } else {
                            Button("Send Now") { offline.kick() }.buttonStyle(.borderless).bold()
                        }
                    }
                    let choices = offline.waiting.needingChoice.count
                    if choices > 0 {
                        Label("\(choices == 1 ? "A form needs" : "\(choices) forms need") your choice: someone else changed the same fields. Open \(choices == 1 ? "it" : "them") to choose.",
                              systemImage: "exclamationmark.triangle")
                            .font(.subheadline).foregroundStyle(.orange)
                    }
                }
            }
        }
    }
}

/// A form's unsent work, in a word or two.
enum WaitingBadge {
    static func text(for id: Int, in waiting: OfflineStore.Waiting) -> (text: String, icon: String, urgent: Bool)? {
        let edits = waiting.edits.first { $0.submissionId == id }
        let files = waiting.uploads.filter { $0.submissionId == id }
        switch edits?.state {
        case .needsChoice?: return ("Needs your choice", "exclamationmark.triangle", true)
        case .refused?: return ("Not sent", "exclamationmark.circle", true)
        case .waiting?: return ("Waiting to send", "arrow.up.circle", false)
        case .editing?: return ("Unsaved changes on this iPhone", "pencil.circle", false)
        case nil: break
        }
        if files.contains(where: { $0.problem != nil }) { return ("A file was not sent", "exclamationmark.circle", true) }
        if !files.isEmpty { return ("\(files.count) \(files.count == 1 ? "file" : "files") waiting", "arrow.up.circle", false) }
        return nil
    }
}

/// A form's unsent work, observing what is waiting on its own.
struct WaitingBadgeLabel: View {
    @EnvironmentObject private var offline: OfflineSync
    let id: Int

    var body: some View {
        if let waiting = WaitingBadge.text(for: id, in: offline.waiting) {
            Label(waiting.text, systemImage: waiting.icon)
                .font(.caption).foregroundStyle(waiting.urgent ? .orange : .secondary)
        }
    }
}
