import ERISKit
import SwiftUI

/// Distinct from incident and submission ids in a navigation path.
struct AssessmentRoute: Hashable {
    let id: Int
}

struct AssessmentRow: View {
    let assessment: Assessment

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Side by side only while both fit: at a large text size, one above the other.
            ViewThatFits(in: .horizontal) {
                HStack {
                    Text("Assessment #\(assessment.id)").font(.headline).fixedSize()
                    Spacer()
                    AssessmentStateBadge(state: assessment.state).fixedSize()
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Assessment #\(assessment.id)").font(.headline)
                    AssessmentStateBadge(state: assessment.state)
                }
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
            // Not a capsule: at a large text size the label takes two lines and would touch its curve.
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(color))
    }
}

struct AssessmentDetailView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var offline: OfflineSync
    /// When the assessment shown was kept on this iPhone, because ERIS could not be reached.
    @State private var keptAt: Date?
    let assessmentId: Int
    let me: Me
    @State private var detail: AssessmentDetail?
    @State private var branchChiefs: [PickerSection] = []
    @State private var staff: [PickerSection] = []
    // Nothing is preselected, even with one candidate: the hand-off is a
    // deliberate human choice (owner decision 7).
    @State private var branchChiefId = PersonPicker.initialValue()
    @State private var staffId = PersonPicker.initialValue()
    @State private var seniorId = PersonPicker.initialValue()
    @State private var confirmingSubmit = false
    @State private var seniors: [PickerSection] = []
    @State private var notes = ""
    @State private var error: String?
    @State private var actionError: String?
    @State private var working = false
    /// Changed after each step, to bring the new state into view.
    @State private var stepsDone = 0

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
        // Kept current: a step taken elsewhere (on the web) shows here.
        .onChange(of: offline.rounds) { if !working { Task { await load() } } }
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
        ScrollViewReader { scroller in
        List {
            OfflineStatusSection(keptAt: keptAt)
            Section {
                AssessmentStateBadge(state: assessment.state)
                    .id("state")
                // Office and branch by name from the routing snapshot: what they
                // read when this assessment was routed, not what they are called today.
                LabeledContent("Incident", value: "#\(assessment.incidentId)")
                LabeledContent("Office", value: assessment.officeLabel)
                if let branch = assessment.branchLabel { LabeledContent("Branch", value: branch) }
            }

            // The form is what this screen is for, so it is the one thing that stands out.
            if let submissionId = assessment.submissionId {
                Section {
                    NavigationLink(value: SubmissionRoute(id: submissionId)) {
                        Label("Open technical form #\(submissionId)", systemImage: "doc.text")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .frame(minHeight: 44)
                    }
                    // A list ignores button styles on a link: the row itself is the button.
                    .listRowBackground(Color.accentColor)
                    .tint(.white)
                }
            }

            if actions.delegate || actions.assign || actions.submit || actions.review {
                Section {
                    TextField("Notes (optional)", text: $notes, axis: .vertical)
                        .lineLimit(2...6)
                } header: {
                    Text("Notes")
                }
            }

            if actions.delegate {
                PersonPickerSections(title: "Delegate to a branch chief", sections: branchChiefs,
                                     empty: "No branch chiefs configured for this office.", selection: $branchChiefId)
                PersonPickerSections(title: "Or assign a Senior Specialist", sections: seniors,
                                     empty: "No Senior Specialists are recorded for this office.", selection: $seniorId)
            }

            if actions.assignNotOnThisRoute {
                Section {
                    Text("Staff are assigned only on the branch route.").foregroundStyle(.secondary)
                }
            }

            if actions.assign {
                PersonPickerSections(title: "Assign a Staff member", sections: staff,
                                     empty: "No Staff members are recorded for this branch.", selection: $staffId)
            }

            if actions.submit {
                Section {
                    // A step down from the form, and never one tap: it leaves this person's hands.
                    Button("Submit for review") { confirmingSubmit = true }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                        .disabled(working)
                        .confirmationDialog("Submit for review?", isPresented: $confirmingSubmit, titleVisibility: .visible) {
                            Button("Submit") {
                                run { try await $0.submit(assessment.id, notes: notes) }
                            }
                            Button("Keep Working", role: .cancel) {}
                        } message: {
                            Text("Make sure the form is finished. It cannot be edited until it is returned.")
                        }
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

            AssessmentTimelineSection(events: detail.events)
        }
        // One choice of two: a branch chief, or a Senior Specialist.
        .onChange(of: branchChiefId) { _, chosen in if chosen != nil { seniorId = nil } }
        .onChange(of: seniorId) { _, chosen in if chosen != nil { branchChiefId = nil } }
        // Back to the top after a step, as the Expo sheet reopened there.
        .onChange(of: stepsDone) { withAnimation { scroller.scrollTo("state", anchor: .top) } }
        .safeAreaInset(edge: .bottom) {
            if actions.delegate {
                let chosen = PersonPicker.selectedPerson(branchChiefs, branchChiefId)
                let chosenSenior = PersonPicker.selectedPerson(seniors, seniorId)
                if let chosenSenior {
                    HandOffBar(hint: nil, warning: nil, title: "Assign \(chosenSenior.fullName)", enabled: !working) {
                        run { try await $0.assignSenior(assessment.id, seniorEngineerUserId: chosenSenior.id, notes: notes) }
                    }
                } else {
                    HandOffBar(hint: chosen == nil ? "Choose a branch chief or a Senior Specialist above." : nil, warning: nil,
                               title: chosen.map { "Delegate to \($0.fullName)" } ?? "Delegate to branch chief",
                               enabled: !working && chosen != nil) {
                        guard let chosen else { return }
                        run { try await $0.delegateBranch(assessment.id, branchChiefUserId: chosen.id, notes: notes) }
                    }
                }
            } else if actions.assign {
                HandOffBar(hint: chosenStaff == nil ? "Choose a Staff member above." : nil, warning: nil,
                           title: chosenStaff.map { "Assign \($0.fullName)" } ?? "Assign Staff member",
                           enabled: !working && chosenStaff != nil) {
                    guard let chosenStaff else { return }
                    run { try await $0.assignEngineer(assessment.id, engineerUserId: chosenStaff.id, notes: notes) }
                }
            }
        }
        }
    }

    private func load() async {
        let assessments = AssessmentsAPI(api: model.api)
        do {
            let answer = try await assessments.detail(assessmentId, keepingIn: offline.store)
            let loaded = answer.value
            keptAt = answer.keptAt
            let actions = AssessmentActions(assessment: loaded.assessment, roles: me.roles, meId: me.id)
            // A picker that fails to load shows as empty, as in the Expo app.
            branchChiefs = actions.delegate ? ((try? await assessments.branchOptions(assessmentId))?.sections ?? []) : []
            seniors = actions.delegate ? ((try? await assessments.seniorOptions(assessmentId))?.sections ?? []) : []
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
                seniorId = PersonPicker.initialValue()
                await load()
                stepsDone += 1
            } catch {
                actionError = model.handle(error)
            }
        }
    }
}

/// The confirm step of a hand-off, kept in reach below the picker: choosing a
/// person and handing the work to them are separate acts.
struct HandOffBar: View {
    let hint: String?
    let warning: String?
    let title: String
    let enabled: Bool
    let confirm: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            if let warning {
                Text(warning).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
            } else if let hint {
                Text(hint).font(.footnote).foregroundStyle(.secondary)
            }
            Button(action: confirm) {
                Text(title).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!enabled)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
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

/// What has happened to an assessment, oldest first.
struct AssessmentTimelineSection: View {
    let events: [AssessmentEvent]

    var body: some View {
        Section("Timeline") {
            if events.isEmpty {
                Text("Nothing recorded yet.").foregroundStyle(.secondary)
            }
            ForEach(events) { event in
                VStack(alignment: .leading, spacing: 2) {
                    Text(event.eventType + (event.disposition.map { " · \($0)" } ?? ""))
                        .font(.subheadline.weight(.semibold))
                    if event.fromState != nil || event.toState != nil {
                        Text("\(event.fromState ?? "—") → \(event.toState ?? "—")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let note = event.notes, !note.isEmpty { Text(note).font(.caption) }
                    Text("by \(event.actorLabel)\(ServerDate.display(event.createdAt).map { " · \($0)" } ?? "")")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}
