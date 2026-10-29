import ERISKit
import SwiftUI

/// A step in My Work, or a record opened from a notification.
struct WorkRoute: Hashable {
    enum Kind: Hashable { case triage, maintenance, share, assessment, incident }
    let kind: Kind
    let id: Int

    init(_ kind: Kind, _ id: Int) {
        self.kind = kind
        self.id = id
    }

    init(_ item: MyWork.Item) {
        switch item {
        case .triage(let incident): self.init(.triage, incident.id)
        case .maintenance(let report): self.init(.maintenance, report.id)
        case .share(let review): self.init(.share, review.reviewId)
        case .assessment(let assessment): self.init(.assessment, assessment.id)
        }
    }
}

/// My Work: everything waiting on this person, as on the web, and nothing to
/// browse. Each item opens the screen that does its step.
struct MyWorkView: View {
    @EnvironmentObject private var model: AppModel
    /// The queue, kept current without being asked (OfflineSync.catchUp).
    @EnvironmentObject private var offline: OfflineSync
    let me: Me
    @Binding var path: NavigationPath
    @State private var notice: String?
    @State private var includeOthers = false
    @AppStorage("myWork.show") private var show = MyWork.Filter.both.rawValue

    private var admin: Bool { RoleModel.isAdmin(me.roles) }
    private var loaded: MyWork.Loaded { offline.work }
    private var didLoad: Bool { offline.workLoaded }
    private var filter: MyWork.Filter { MyWork.Filter(rawValue: show) ?? .both }

    var body: some View {
        let items = MyWork.items(loaded, includeOtherReports: includeOthers, filter: filter, admin: admin)
        List {
            if let notice {
                Section { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.green).font(.subheadline) }
            }
            OfflineStatusSection(keptAt: loaded.keptAt)
            if admin {
                Picker("Show", selection: $show) {
                    ForEach(MyWork.Filter.allCases) { Text($0.label).tag($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if loaded.otherReports > 0 && (!admin || filter != .geotech) {
                Toggle("Also show maintenance reports not waiting on me (\(loaded.otherReports))", isOn: $includeOthers)
                    .font(.subheadline)
            }
            if items.isEmpty && didLoad {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Nothing needs your attention").font(.headline)
                    Text("Steps waiting on you appear here.").foregroundStyle(.secondary)
                }
            }
            Section {
                ForEach(items) { item in
                    NavigationLink(value: WorkRoute(item)) { WorkRow(item: item) }
                }
            } footer: {
                if !items.isEmpty { Text("\(items.count) \(items.count == 1 ? "item" : "items") waiting on you") }
            }
        }
        .overlay { if !didLoad { ProgressView() } }
        .navigationTitle("My Work")
        .navigationDestination(for: WorkRoute.self) { destination($0) }
        .navigationDestination(for: AssessmentRoute.self) { AssessmentDetailView(assessmentId: $0.id, me: me) }
        .navigationDestination(for: SubmissionRoute.self) { SubmissionDetailView(submissionId: $0.id) }
        .refreshable { await offline.catchUp() }
    }

    @ViewBuilder
    private func destination(_ route: WorkRoute) -> some View {
        switch route.kind {
        case .triage:
            TriageView(incidentId: route.id, done: finished)
        case .maintenance:
            MaintenanceReportView(incidentId: route.id, done: finished)
        case .share:
            if let review = loaded.shares.first(where: { $0.reviewId == route.id }) {
                ShareReviewView(review: review, done: finished)
            } else {
                Text("This share is no longer waiting on you.").foregroundStyle(.secondary)
            }
        case .assessment:
            AssessmentDetailView(assessmentId: route.id, me: me)
        case .incident:
            ReportDetailView(incidentId: route.id)
        }
    }

    /// After a step: back to the list, saying what happened.
    private func finished(_ message: String) {
        notice = message
        if !path.isEmpty { path.removeLast(path.count) }
        Task { await offline.catchUp() }
    }
}

/// One step in the list.
private struct WorkRow: View {
    let item: MyWork.Item

    var body: some View {
        switch item {
        case .triage(let incident):
            row("Triage · Report #\(incident.id)", incident.title ?? "Field report",
                [incident.locationLine, ServerDate.display(incident.firstObservedAt).map { "Reported \($0)" }],
                badge: "New report", urgent: true)
        case .maintenance(let report):
            row("Maintenance · Report #\(report.id)", report.title ?? "Field report", [report.districtLabel, report.status],
                badge: report.myTurn ? "Your action needed" : "For reading", urgent: report.myTurn)
        case .share(let review):
            row("Sharing · Form #\(review.submission.id)", "\(review.owner.label) → \(review.recipient.label)",
                [review.unitLabel], badge: review.isApproval ? "Needs approval" : "For your information", urgent: review.isApproval)
        case .assessment(let assessment):
            AssessmentRow(assessment: assessment)
        }
    }

    private func row(_ title: String, _ subtitle: String, _ details: [String?], badge: String, urgent: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline)
                Spacer()
                Text(badge).font(.caption.weight(.semibold)).foregroundStyle(urgent ? Color.orange : .secondary)
            }
            Text(subtitle).font(.subheadline)
            let line = details.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if !line.isEmpty { Text(line).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - The report and its evidence

/// What was reported: where, when, and the reporter's words.
struct ReportFactsSection: View {
    let incident: Incident

    var body: some View {
        Section {
            Text(incident.displayTitle).font(.headline)
            if !incident.locationLine.isEmpty { LabeledContent("Location", value: incident.locationLine) }
            if let latitude = incident.latitude, let longitude = incident.longitude {
                LabeledContent("Coordinates", value: String(format: "%.5f, %.5f", latitude, longitude))
            }
            if let observed = ServerDate.display(incident.firstObservedAt) { LabeledContent("First seen", value: observed) }
            if let description = incident.description, !description.isEmpty {
                Text(description).font(.callout)
            }
        } header: {
            Text("What was reported")
        }
    }
}

/// The report's photos and files from the field; a tap shows one large.
struct EvidenceSection: View {
    let items: [IncidentEvidence]?
    @State private var shown: IncidentEvidence?

    var body: some View {
        Section("Evidence from the field") {
            if let items {
                if items.isEmpty {
                    Text("No evidence attached.").foregroundStyle(.secondary)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(items) { item in
                                Button { shown = item } label: { tile(item) }
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel(item.fileName ?? "Evidence")
                            }
                        }
                    }
                }
            } else {
                ProgressView()
            }
        }
        .sheet(item: $shown) { item in
            NavigationStack {
                Group {
                    if item.isPhoto {
                        AsyncImage(url: item.downloadUrl.flatMap(URL.init(string:))) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }
                    } else if let url = item.downloadUrl.flatMap(URL.init(string:)) {
                        Link("Open \(item.fileName ?? "file")", destination: url)
                    }
                }
                .navigationTitle(item.fileName ?? "Evidence")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { shown = nil } }
            }
        }
    }

    private func tile(_ item: IncidentEvidence) -> some View {
        Group {
            if item.isPhoto {
                AsyncImage(url: item.downloadUrl.flatMap(URL.init(string:))) { $0.resizable().scaledToFill() } placeholder: {
                    Color.gray.opacity(0.15)
                }
            } else {
                Color.gray.opacity(0.15).overlay(Image(systemName: "doc").foregroundStyle(.secondary))
            }
        }
        .frame(width: 120, height: 90)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Triage

/// Coordinator triage of a field report, as the web's triage dialog: the report
/// and its evidence first, then the decision. Only "Assessment required" asks
/// which Incident Group it joins; the decision and group are saved together.
struct TriageView: View {
    @EnvironmentObject private var model: AppModel
    let incidentId: Int
    let done: (String) -> Void
    @State private var incident: Incident?
    @State private var evidence: [IncidentEvidence]?
    @State private var draft: Triage.Draft
    @State private var groups: [NearbyEventGroup]?
    @State private var newGroupTitle = ""
    @State private var candidates: [Triage.Candidate]?
    @State private var manualDuplicate = ""
    @State private var error: String?
    @State private var working = false

    init(incidentId: Int, done: @escaping (String) -> Void) {
        self.incidentId = incidentId
        self.done = done
        _draft = State(initialValue: Triage.Draft(incidentId: incidentId))
    }

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let incident {
                ReportFactsSection(incident: incident)
                EvidenceSection(items: evidence)
            }
            Section {
                ForEach(Triage.Disposition.allCases) { option in
                    choice(option.label, option.explanation, chosen: draft.disposition == option) { draft.disposition = option }
                }
            } header: {
                Text("Decision")
            }
            switch draft.disposition {
            case .assessmentRequired?: groupSection
            case .needsReporterInformation?: correctionsSection
            case .duplicateOrLinked?: duplicateSection
            default: EmptyView()
            }
            Section("Notes") {
                TextField("Notes (optional)", text: $draft.notes, axis: .vertical).lineLimit(2...6)
            }
            Section {
                Button(working ? "Recording…" : draft.confirmLabel) { Task { await confirm() } }
                    .bold()
                    .disabled(working || draft.blocker != nil)
            } footer: {
                if let blocker = draft.blocker { Text(blocker) }
            }
        }
        .navigationTitle("Triage · Report #\(incidentId)")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: draft.disposition) { _, disposition in
            Task {
                if disposition == .assessmentRequired, groups == nil { await loadGroups() }
                if disposition == .duplicateOrLinked, candidates == nil { await loadCandidates() }
            }
        }
    }

    private var groupSection: some View {
        Section {
            if let groups {
                ForEach(groups) { group in
                    choice(group.title ?? "Incident Group #\(group.id)",
                           [group.distance, group.incidentCount.map { "\($0) \($0 == 1 ? "report" : "reports")" }]
                            .compactMap { $0 }.joined(separator: " · "),
                           chosen: draft.group == .existing(group.id)) { draft.group = .existing(group.id) }
                }
                if groups.isEmpty { Text("No open Incident Groups within 25 miles.").foregroundStyle(.secondary) }
            } else {
                ProgressView()
            }
            choice("Start a new Incident Group", "Named after this report unless you give it a name.",
                   chosen: isNewGroup) { draft.group = .new(title: newGroupTitle, description: "") }
            if isNewGroup {
                TextField("New group name (optional)", text: $newGroupTitle)
                    .onChange(of: newGroupTitle) { _, title in draft.group = .new(title: title, description: "") }
            }
        } header: {
            Text("Incident Group")
        } footer: {
            Text("Open groups near this report, nearest first. The assessment goes to the district's GeoTech office.")
        }
    }

    private var isNewGroup: Bool {
        if case .new? = draft.group { return true }
        return false
    }

    private var correctionsSection: some View {
        Section {
            ForEach(Triage.revisionFields, id: \.key) { field in
                Toggle(field.label, isOn: Binding(
                    get: { draft.revisionFields.contains(field.key) },
                    set: { on in
                        if on { draft.revisionFields.append(field.key) } else { draft.revisionFields.removeAll { $0 == field.key } }
                    }))
            }
        } header: {
            Text("What the reporter should correct")
        } footer: {
            Text("Choose fields, say what to fix in the notes, or both.")
        }
    }

    private var duplicateSection: some View {
        Section {
            if let candidates {
                ForEach(candidates) { candidate in
                    choice("Report #\(candidate.id) · \(candidate.incident.title ?? "Field report")",
                           Triage.distanceLabel(candidate.distanceM),
                           chosen: draft.duplicateOf == candidate.id) {
                        manualDuplicate = ""
                        draft.duplicateOf = candidate.id
                    }
                }
                if candidates.isEmpty { Text("No other reports within 5 miles.").foregroundStyle(.secondary) }
            } else {
                ProgressView()
            }
            TextField("Or the report number", text: $manualDuplicate)
                .keyboardType(.numberPad)
                .onChange(of: manualDuplicate) { _, raw in
                    let id = Int(raw)
                    draft.duplicateOf = id.flatMap { $0 > 0 && $0 != incidentId ? $0 : nil }
                }
        } header: {
            Text("The report it repeats")
        }
    }

    private func choice(_ title: String, _ detail: String, chosen: Bool, pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            HStack(alignment: .top) {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.primary)
                    if !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
                }
            }
        }
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    private func load() async {
        let incidents = IncidentsAPI(api: model.api)
        do {
            incident = try await incidents.get(incidentId)
            evidence = (try? await incidents.evidence(incidentId)) ?? []
        } catch {
            self.error = model.handle(error)
        }
    }

    private func loadGroups() async {
        groups = (try? await IncidentsAPI(api: model.api).nearbyEventGroups(incidentId)) ?? []
    }

    private func loadCandidates() async {
        guard let incident else { candidates = []; return }
        let reports = (try? await IncidentsAPI(api: model.api).list(limit: 1000)) ?? []
        candidates = Triage.duplicateCandidates(of: incident, among: reports)
    }

    private func confirm() async {
        working = true
        defer { working = false }
        do {
            let assessment = try await IncidentsAPI(api: model.api).triage(draft)
            done(draft.outcome(assessmentId: assessment))
        } catch {
            self.error = model.handle(error)
        }
    }
}

// MARK: - Maintenance review

/// A report in its district's maintenance workflow: where its review stands,
/// and the step for whoever's turn it is (review, decide, ask the reporter,
/// supply information, edit, restart), as the web's workflow panel.
struct MaintenanceReportView: View {
    @EnvironmentObject private var model: AppModel
    let incidentId: Int
    let done: (String) -> Void
    @State private var incident: Incident?
    @State private var evidence: [IncidentEvidence]?
    @State private var workflow: MaintenanceWorkflow?
    @State private var action: MaintenanceWorkflow.Action?
    @State private var notes = ""
    @State private var description = ""
    @State private var groupId: Int?
    @State private var newGroupTitle = ""
    @State private var error: String?
    @State private var working = false
    @State private var confirmingRestart = false

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let incident {
                ReportFactsSection(incident: incident)
                EvidenceSection(items: evidence)
            }
            if let workflow {
                Section {
                    ForEach(Array(workflow.steps.enumerated()), id: \.offset) { index, step in
                        let current = index == workflow.state.stepIndex && workflow.outcome == nil
                        Label("\(index + 1). \(step.name)", systemImage: index < workflow.state.stepIndex || workflow.outcome != nil
                              ? "checkmark.circle.fill" : current ? "circle.inset.filled" : "circle")
                            .fontWeight(current ? .semibold : .regular)
                    }
                    Text(workflow.standing).font(.subheadline)
                    if let assigned = workflow.assignedLine { Text(assigned).font(.caption).foregroundStyle(.secondary) }
                } header: {
                    Text("Review path · District \(Int(workflow.district).map(String.init) ?? workflow.district)")
                }
                if !workflow.actions.isEmpty { actionSections(workflow) }
                if !workflow.events.isEmpty {
                    Section("History") {
                        ForEach(workflow.events) { event in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(event.label) · \(event.actorName ?? "")").font(.subheadline.weight(.semibold))
                                if let when = ServerDate.display(event.createdAt) { Text(when).font(.caption).foregroundStyle(.secondary) }
                                if let note = event.notes, !note.isEmpty { Text(note).font(.caption) }
                            }
                        }
                    }
                }
            } else if error == nil {
                ProgressView()
            }
        }
        .navigationTitle("Report #\(incidentId)")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Restart on the latest district workflow?", isPresented: $confirmingRestart, titleVisibility: .visible) {
            Button("Restart", role: .destructive) { Task { await record() } }
        } message: {
            Text("Previous reviews remain in history; review starts again from step one.")
        }
    }

    @ViewBuilder
    private func actionSections(_ workflow: MaintenanceWorkflow) -> some View {
        Section("Your next action") {
            ForEach(workflow.actions) { option in
                Button {
                    action = option
                    if option.changesDescription { description = incident?.description ?? "" }
                } label: {
                    Label(option.label, systemImage: action == option ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(.primary)
                }
                .accessibilityAddTraits(action == option ? .isSelected : [])
            }
        }
        if let action {
            if action.changesDescription {
                Section {
                    TextField("Report description", text: $description, axis: .vertical).lineLimit(3...10)
                } header: {
                    Text("Report description")
                } footer: {
                    Text("Updating it restarts review at step one.")
                }
            }
            if action == .geotech {
                Section {
                    let locked = workflow.state.decision != nil
                    Picker("Incident Group", selection: $groupId) {
                        Text("Create a new Incident Group").tag(Int?.none)
                        ForEach(workflow.groups) { Text($0.title).tag(Int?.some($0.id)) }
                    }
                    .disabled(locked)
                    if groupId == nil {
                        TextField("New group name (optional)", text: $newGroupTitle).disabled(locked)
                    }
                } footer: {
                    Text("The referral goes to the district's GeoTech office. When every decision maker must agree, all choose the same outcome and Incident Group.")
                }
            }
            Section {
                TextField("Review notes / reason (required)", text: $notes, axis: .vertical).lineLimit(2...6)
                    .accessibilityLabel("Review notes")
                    .accessibilityIdentifier("review-notes")
                Button(working ? "Recording…" : "Record Action") {
                    if action == .restart { confirmingRestart = true } else { Task { await record() } }
                }
                .bold()
                .disabled(working || notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func load() async {
        let incidents = IncidentsAPI(api: model.api)
        do {
            async let report = incidents.get(incidentId)
            async let flow = incidents.maintenanceWorkflow(incidentId)
            incident = try await report
            let loaded = try await flow
            workflow = loaded
            if let decision = loaded.state.decision {
                groupId = decision.eventGroupId
                newGroupTitle = decision.newGroupTitle ?? ""
            }
            evidence = (try? await incidents.evidence(incidentId)) ?? []
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }

    private func record() async {
        guard let workflow, let action,
              let body = workflow.request(action, notes: notes, description: description, groupId: groupId,
                                          newGroupTitle: newGroupTitle) else { return }
        working = true
        defer { working = false }
        do {
            let next = try await IncidentsAPI(api: model.api).act(on: incidentId, body)
            done(next.doneMessage)
        } catch APIError.http(409, let detail) {
            // Someone acted first: show the review as it now stands.
            error = detail ?? "Someone else acted on this report first. It has been reloaded."
            self.action = nil
            await load()
        } catch {
            self.error = model.handle(error)
        }
    }
}

// MARK: - Sharing

/// A share of a technical form waiting on a branch or office chief.
struct ShareReviewView: View {
    @EnvironmentObject private var model: AppModel
    let review: ShareReview
    let done: (String) -> Void
    @State private var note = ""
    @State private var error: String?
    @State private var working = false

    var body: some View {
        List {
            Section {
                Text(review.headline).font(.headline)
                NavigationLink(value: SubmissionRoute(id: review.submission.id)) {
                    LabeledContent("Form", value: "Technical form #\(review.submission.id)")
                }
                LabeledContent("Owner", value: [review.owner.label, review.owner.placement].compactMap { $0 }.joined(separator: " · "))
                if review.sharer.id != review.owner.id { LabeledContent("Shared by", value: review.sharer.label) }
                LabeledContent("With", value: [review.recipient.label, review.recipient.placement].compactMap { $0 }.joined(separator: " · "))
                LabeledContent("Gives", value: "Viewing and editing")
            } header: {
                Text(review.isApproval ? "Sharing to approve · \(review.unitLabel)" : "Sharing you were told about · \(review.unitLabel)")
            }
            Section {
                Text(review.explanation).font(.subheadline)
                ForEach(review.reviews) { Text($0.line).font(.caption).foregroundStyle(.secondary) }
            }
            Section {
                TextField(review.isApproval ? "Why, if you reject it" : "Why, if you stop it", text: $note, axis: .vertical)
                    .lineLimit(2...4)
                ForEach(review.decisions, id: \.0.rawValue) { decision, label in
                    Button(label, role: decision == .reject ? .destructive : nil) { Task { await decide(decision) } }
                        .disabled(working)
                }
            } footer: {
                if let error { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Sharing · Form #\(review.submission.id)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func decide(_ decision: ShareReview.Decision) async {
        working = true
        defer { working = false }
        do {
            let status = try await SubmissionsAPI(api: model.api).decide(review, decision, note: note)
            done(review.outcome(decision, status: status))
        } catch {
            self.error = model.handle(error)
        }
    }
}
