import ERISKit
import SwiftUI

/// The assessment worklists (`GET /assessments?queue=`), as in
/// mobile/app/(tabs)/assessments/index.tsx.
struct AssessmentsView: View {
    @EnvironmentObject private var model: AppModel
    let me: Me
    @State private var tab = AssessmentTab.all
    @State private var items: [Assessment] = []
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        List {
            Picker("Worklist", selection: $tab) {
                ForEach(AssessmentTab.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
            if let error {
                Text(error).foregroundStyle(.red)
            }
            ForEach(items) { item in
                NavigationLink(value: AssessmentRoute(id: item.id)) {
                    AssessmentRow(assessment: item)
                }
            }
            if !loading && items.isEmpty && error == nil {
                Text("No assessments in this queue.").foregroundStyle(.secondary)
            }
        }
        .overlay { if loading && items.isEmpty { ProgressView() } }
        .navigationTitle("Assessments")
        .navigationDestination(for: AssessmentRoute.self) { AssessmentDetailView(assessmentId: $0.id, me: me) }
        .navigationDestination(for: SubmissionRoute.self) { SubmissionDetailView(submissionId: $0.id) }
        .refreshable { await load() }
        .task(id: tab) { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            items = try await AssessmentsAPI(api: model.api).list(queue: tab.queue)
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }
}

/// Distinct from incident and submission ids in a navigation path.
struct AssessmentRoute: Hashable {
    let id: Int
}

struct AssessmentRow: View {
    let assessment: Assessment

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Assessment #\(assessment.id)").font(.headline)
                Spacer()
                AssessmentStateBadge(state: assessment.state)
            }
            Text("Incident #\(assessment.incidentId) · \(assessment.officeLabel) · District \(assessment.district ?? "—")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

struct AssessmentStateBadge: View {
    let state: String

    private var color: Color {
        switch AssessmentTone(state: state) {
        case .done: return .green
        case .attention: return .red
        case .inReview: return .blue
        case .waiting: return .orange
        case .neutral: return .gray
        }
    }

    var body: some View {
        Text(RoleModel.assessmentStateLabel(state))
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .overlay(Capsule().stroke(color))
    }
}

struct AssessmentDetailView: View {
    @EnvironmentObject private var model: AppModel
    let assessmentId: Int
    let me: Me
    @State private var detail: AssessmentDetail?
    @State private var branchChiefs: [PickerSection] = []
    @State private var staff: [PickerSection] = []
    // Nothing is preselected, even with one candidate: the hand-off is a
    // deliberate human choice (owner decision 7).
    @State private var branchChiefId = PersonPicker.initialValue()
    @State private var staffId = PersonPicker.initialValue()
    @State private var notes = ""
    @State private var error: String?
    @State private var actionError: String?
    @State private var working = false

    var body: some View {
        Group {
            if let detail {
                content(detail)
            } else if let error {
                Text(error).foregroundStyle(.red).padding()
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Assessment #\(assessmentId)")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .alert("Action failed", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
    }

    @ViewBuilder
    private func content(_ detail: AssessmentDetail) -> some View {
        let assessment = detail.assessment
        let actions = AssessmentActions(assessment: assessment, roles: me.roles, meId: me.id)
        let chosenStaff = PersonPicker.selectedPerson(staff, staffId)
        let outOfBranch = PersonPicker.isOutOfBranchChoice(chosenStaff, assessmentBranchId: assessment.routedBranchId)
        let hasNotes = !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        List {
            Section {
                AssessmentStateBadge(state: assessment.state)
                // Office and branch by name from the routing snapshot: what they
                // read when this assessment was routed, not what they are called today.
                LabeledContent("Incident", value: "#\(assessment.incidentId)")
                LabeledContent("Office", value: assessment.officeLabel)
                if let branch = assessment.branchLabel { LabeledContent("Branch", value: branch) }
                if let submissionId = assessment.submissionId {
                    NavigationLink(value: SubmissionRoute(id: submissionId)) {
                        Text("Open technical form #\(submissionId)")
                    }
                }
            }

            if actions.delegate || actions.assign || actions.submit || actions.review {
                Section {
                    TextField(outOfBranch ? "Required: why this Staff member, from another branch" : "Notes (optional)",
                              text: $notes, axis: .vertical)
                        .lineLimit(2...6)
                } header: {
                    Text("Notes")
                }
            }

            if actions.delegate {
                PersonPickerSections(title: "Delegate to a branch chief", sections: branchChiefs,
                                     empty: "No branch chiefs configured for this office.", selection: $branchChiefId)
                Section {
                    Button(PersonPicker.selectedPerson(branchChiefs, branchChiefId).map { "Delegate to \($0.fullName)" }
                           ?? "Delegate to branch chief") {
                        guard let chosen = branchChiefId else { return }
                        run { try await $0.delegateBranch(assessment.id, branchChiefUserId: chosen, notes: notes) }
                    }
                    .disabled(working || branchChiefId == nil)
                }
            }

            if actions.assignNotOnThisRoute {
                Section {
                    Text("Staff are assigned only on the branch route.").foregroundStyle(.secondary)
                }
            }

            if actions.assign {
                PersonPickerSections(title: "Assign a Staff member", sections: staff,
                                     empty: "No Staff members are recorded for this office.", selection: $staffId)
                Section {
                    Button("Assign Staff member") {
                        guard let chosen = staffId else { return }
                        run { try await $0.assignEngineer(assessment.id, engineerUserId: chosen, notes: notes) }
                    }
                    .disabled(working || staffId == nil || (outOfBranch && !hasNotes))
                } footer: {
                    if outOfBranch, let chosenStaff {
                        Text("\(chosenStaff.fullName) is in \(chosenStaff.placeNote ?? "another branch"), not \(assessment.branchLabel ?? "this branch"). Record why in the notes to assign them anyway.")
                            .foregroundStyle(.red)
                    } else {
                        Text("Assigning outside this branch is allowed; record why in the notes.")
                    }
                }
            }

            if actions.submit {
                Section {
                    Button("Submit for review") {
                        run { try await $0.submit(assessment.id, notes: notes) }
                    }
                    .disabled(working)
                }
            }

            if actions.explainReview {
                Section {
                    if actions.review {
                        Button("Approve") {
                            run { try await $0.review(assessment.id, action: .approve, notes: notes) }
                        }
                        .foregroundStyle(.green)
                        .disabled(working)
                        Button("Request revision") {
                            run { try await $0.review(assessment.id, action: .requestRevision, notes: notes) }
                        }
                        .foregroundStyle(.orange)
                        .disabled(working)
                    }
                } footer: {
                    Text("Only the branch chief (or the office chief on the Senior Specialist route) can decide this.")
                }
            }

            Section("Timeline") {
                if detail.events.isEmpty {
                    Text("Nothing recorded yet.").foregroundStyle(.secondary)
                }
                ForEach(detail.events) { event in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.eventType + (event.disposition.map { " · \($0)" } ?? ""))
                            .font(.subheadline.weight(.semibold))
                        if event.fromState != nil || event.toState != nil {
                            Text("\(event.fromState ?? "—") → \(event.toState ?? "—")")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let note = event.notes, !note.isEmpty { Text(note).font(.caption) }
                        Text("by \(event.actorLabel)\(event.createdAt.map { " · \($0)" } ?? "")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func load() async {
        let assessments = AssessmentsAPI(api: model.api)
        do {
            let loaded = try await assessments.detail(assessmentId)
            let actions = AssessmentActions(assessment: loaded.assessment, roles: me.roles, meId: me.id)
            // A picker that fails to load shows as empty, as in the Expo app.
            branchChiefs = actions.delegate ? ((try? await assessments.branchOptions(assessmentId))?.sections ?? []) : []
            staff = actions.assign ? ((try? await assessments.engineerOptions(assessmentId))?.sections ?? []) : []
            detail = loaded
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }

    /// Runs one workflow step, then starts the screen afresh from the server.
    private func run(_ step: @escaping (AssessmentsAPI) async throws -> Void) {
        Task {
            working = true
            defer { working = false }
            do {
                try await step(AssessmentsAPI(api: model.api))
                notes = ""
                branchChiefId = PersonPicker.initialValue()
                staffId = PersonPicker.initialValue()
                await load()
            } catch {
                actionError = model.handle(error)
            }
        }
    }
}

/// A grouped person picker. Everyone is shown: a person away on rotation with
/// their return date, and a group that takes no work, disabled with the reason.
struct PersonPickerSections: View {
    let title: String
    let sections: [PickerSection]
    let empty: String
    @Binding var selection: Int?

    var body: some View {
        if PersonPicker.flatten(sections).isEmpty {
            Section(title) { Text(empty).foregroundStyle(.secondary) }
        }
        ForEach(Array(sections.enumerated()), id: \.offset) { index, section in
            if !section.items.isEmpty {
                Section {
                    ForEach(section.items) { person in
                        PersonPickerRow(person: person, selected: selection == person.id,
                                        disabled: section.disabledReason != nil) {
                            selection = person.id
                        }
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        if index == 0 { Text(title).font(.headline).textCase(nil).foregroundStyle(.primary) }
                        Text([section.label, section.place].compactMap { $0 }.joined(separator: " · "))
                    }
                } footer: {
                    if let reason = section.disabledReason { Text(reason) }
                }
            }
        }
    }
}

struct PersonPickerRow: View {
    let person: RoutingUserOption
    let selected: Bool
    let disabled: Bool
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(person.fullName).font(.body.weight(.semibold))
                    if let place = person.placeNote { Text(place).font(.caption).foregroundStyle(.secondary) }
                    Text(person.workloadNote).font(.caption).foregroundStyle(.secondary)
                    if let availability = person.availabilityNote {
                        Text(availability).font(.caption).foregroundStyle(.orange)
                    }
                    if let email = person.email { Text(email).font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer()
                if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint) }
            }
            .contentShape(Rectangle())
        }
        .foregroundStyle(.primary)
        .disabled(disabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
