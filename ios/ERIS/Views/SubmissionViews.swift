import ERISKit
import SafariServices
import SwiftUI

/// GISA submissions this person can see. Read-only in this phase: the GISA
/// editor (mobile/app/(tabs)/submissions/[id].tsx) is ported next.
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

struct SubmissionDetailView: View {
    @EnvironmentObject private var model: AppModel
    let submissionId: Int
    @State private var detail: SubmissionDetail?
    @State private var error: String?
    @State private var browserURL: IdentifiableURL?

    var body: some View {
        Group {
            if let detail {
                List {
                    Section {
                        LabeledContent("Status", value: SubmissionLabels.status(detail.submission.status))
                        if let submitted = detail.submission.submittedAt { LabeledContent("Submitted", value: submitted) }
                        if let reviewed = detail.submission.reviewedAt { LabeledContent("Reviewed", value: reviewed) }
                        if let comment = detail.submission.reviewComment, !comment.isEmpty {
                            LabeledContent("Review comment", value: comment)
                        }
                        Button("Open latest GISA PDF") { Task { await openPDF() } }
                    }
                    if let photos = detail.photos, !photos.isEmpty {
                        Section("Photos") {
                            ScrollView(.horizontal) {
                                HStack { ForEach(photos) { AttachmentThumbnail(attachment: $0) } }
                            }
                        }
                    }
                    if let gisa = detail.gisa {
                        Section("GISA form") {
                            ForEach(gisa.keys.sorted(), id: \.self) { key in
                                if let value = gisa[key].flatMap(SubmissionLabels.text) {
                                    LabeledContent(SubmissionLabels.fieldName(key), value: value)
                                }
                            }
                        }
                    }
                }
                .navigationTitle(detail.submission.title ?? "Submission #\(submissionId)")
            } else if let error {
                Text(error).foregroundStyle(.red).padding()
            } else {
                ProgressView()
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $browserURL) { SafariView(url: $0.url) }
    }

    private func load() async {
        do {
            detail = try await SubmissionsAPI(api: model.api).detail(submissionId)
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }

    private func openPDF() async {
        do {
            let link = try await SubmissionsAPI(api: model.api).gisaPDF(submissionId)
            if let url = URL(string: link.downloadUrl) { browserURL = IdentifiableURL(url: url) }
        } catch APIError.notFound {
            error = "No GISA PDF has been generated yet."
        } catch {
            self.error = model.handle(error)
        }
    }
}

/// A photo from its presigned link. The link carries its own signature, so it
/// is fetched without the ERIS session token.
struct AttachmentThumbnail: View {
    @EnvironmentObject private var model: AppModel
    let attachment: AttachmentRef
    @State private var url: URL?

    var body: some View {
        AsyncImage(url: url) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Color.gray.opacity(0.15)
        }
        .frame(width: 120, height: 90)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task {
            if let link = try? await SubmissionsAPI(api: model.api).attachmentLink(attachment.id) {
                url = URL(string: link.downloadUrl)
            }
        }
    }
}

struct IdentifiableURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
