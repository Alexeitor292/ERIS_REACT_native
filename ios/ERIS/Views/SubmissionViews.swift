import ERISKit
import SwiftUI

/// GISA submissions this person can see; each opens in the GISA editor.
struct SubmissionsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var items: [SubmissionSummary] = []
    @State private var error: String?
    @State private var loading = false
    @State private var search = ""

    private var filtered: [SubmissionSummary] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return items }
        return items.filter {
            "\($0.id) \($0.status) \($0.displayTitle) \($0.locationLine)".lowercased().contains(query)
        }
    }

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            let working = filtered.filter(\.isWorkInProgress)
            if !working.isEmpty {
                Section("In progress") { ForEach(working) { row($0) } }
            }
            let done = filtered.filter { !$0.isWorkInProgress }
            if !done.isEmpty {
                Section("Submitted") { ForEach(done) { row($0) } }
            }
            if !loading && items.isEmpty && error == nil {
                Text("No submissions yet.").foregroundStyle(.secondary)
            }
        }
        .searchable(text: $search, prompt: "ID, status, route, county")
        .overlay { if loading && items.isEmpty { ProgressView() } }
        .navigationTitle("Submissions")
        .navigationDestination(for: SubmissionRoute.self) { SubmissionDetailView(submissionId: $0.id) }
        .refreshable { await load() }
        .task { await load() }
    }

    private func row(_ item: SubmissionSummary) -> some View {
        NavigationLink(value: SubmissionRoute(id: item.id)) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.displayTitle).font(.headline)
                if !item.locationLine.isEmpty {
                    Text(item.locationLine).font(.subheadline).foregroundStyle(.secondary)
                }
                StatusChip(text: SubmissionLabels.status(item.status))
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            items = try await SubmissionsAPI(api: model.api).list()
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }
}

/// Distinct from incident ids in the navigation path.
struct SubmissionRoute: Hashable {
    let id: Int
}

/// A photo from its presigned link. The link carries its own signature, so it
/// is fetched without the ERIS session token.
struct AttachmentThumbnail: View {
    @EnvironmentObject private var model: AppModel
    let attachment: AttachmentRef
    var size = CGSize(width: 120, height: 90)
    @State private var url: URL?

    var body: some View {
        AsyncImage(url: url) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Color.gray.opacity(0.15)
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task {
            if let link = try? await SubmissionsAPI(api: model.api).attachmentLink(attachment.id) {
                url = URL(string: link.downloadUrl)
            }
        }
    }
}
