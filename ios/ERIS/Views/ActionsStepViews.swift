import ERISKit
import SwiftUI

/// What is typed for a workflow step before it is sent, kept by the form so
/// moving between steps does not lose it.
struct WorkflowDrafts {
    var notifyMessage = ""
    var submitComment = ""
    var reviewComment = ""
}

/// Step 4, Actions, as in the Expo editor: the immediate and follow-up
/// actions, the lanes left open, and telling the maintenance coordinator
/// about immediate actions with a justification.
struct GisaActionsSections: View {
    @Binding var editor: GisaEditor
    @Binding var message: String
    let canEdit: Bool
    let lookups: GisaLookups
    let notices: [GisaWorkflow.CoordinatorNotice]
    let notifying: Bool
    let notify: () -> Void

    enum ActionGroup: String {
        case immediate = "Immediate Actions", followUp = "Follow-up Actions"
    }

    var body: some View {
        Section("Immediate Actions") {
            ActionSummaryRow(group: .immediate, options: lookups.actions.immediate, chosen: $editor.actions.immediate,
                             lookups: lookups, editable: canEdit)
            if (editor.actions.immediate + editor.actions.followUp).contains("OPEN_HIGHWAY_TRAFFIC") {
                GisaTextField(label: "Open Highway Traffic Lanes",
                              value: Binding(get: { editor.form["open_highway_traffic_lanes_count"] },
                                             set: { editor.set("open_highway_traffic_lanes_count", $0) }),
                              editable: canEdit, keyboard: .numberPad,
                              error: editor.errors["open_highway_traffic_lanes_count"])
            }
        }
        if !editor.actions.immediate.isEmpty || !notices.isEmpty {
            Section {
                if !editor.actions.immediate.isEmpty && canEdit {
                    NotesField(label: "Emergency Justification Message", text: $message, editable: !notifying)
                    Button(action: notify) {
                        HStack {
                            Text(notifying ? "Notifying…" : "Notify Coordinator").bold()
                            if notifying { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(notifying)
                }
                ForEach(notices) { notice in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notified\(ServerDate.display(notice.createdAt).map { " \($0)" } ?? "")")
                            .font(.caption.bold())
                        if !notice.actions.isEmpty {
                            Text(GisaWorkflow.actionLabels(notice.actions, lookups: lookups).joined(separator: ", "))
                                .font(.caption)
                        }
                        Text(notice.message).font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Maintenance Coordinator")
            } footer: {
                Text(canEdit && !editor.actions.immediate.isEmpty
                     ? "Saves the form, then sends the immediate actions and this message to the maintenance coordinator."
                     : "Notices sent from this form.")
            }
        }
        Section("Follow-up Actions") {
            ActionSummaryRow(group: .followUp, options: lookups.actions.followUp, chosen: $editor.actions.followUp,
                             lookups: lookups, editable: canEdit)
        }
    }
}

/// The actions chosen in a group, opening the list to choose from. The list
/// is presented from the row: presented from a List section it does not open.
private struct ActionSummaryRow: View {
    let group: GisaActionsSections.ActionGroup
    let options: [GisaOption]
    @Binding var chosen: [String]
    let lookups: GisaLookups
    let editable: Bool
    @State private var choosing = false

    var body: some View {
        let labels = GisaWorkflow.actionLabels(chosen, lookups: lookups)
        Button { choosing = true } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.rawValue).foregroundStyle(.primary)
                    Text(labels.isEmpty ? "None selected" : labels.joined(separator: ", "))
                        .font(.subheadline).foregroundStyle(labels.isEmpty ? .tertiary : .secondary)
                }
                Spacer()
                if editable { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
            }
        }
        .disabled(!editable)
        .accessibilityIdentifier("actions-\(group == .immediate ? "immediate" : "follow-up")")
        .sheet(isPresented: $choosing) { ActionPicker(group: group, options: options, chosen: $chosen) }
    }
}

/// Ticks actions on and off, in the server's order. A saved code the list no
/// longer offers stays chosen and can be unticked.
private struct ActionPicker: View {
    @Environment(\.dismiss) private var dismiss
    let group: GisaActionsSections.ActionGroup
    let options: [GisaOption]
    @Binding var chosen: [String]

    var body: some View {
        NavigationStack {
            List {
                if options.isEmpty {
                    Text("The list of actions could not be loaded. Check the connection and open the form again.")
                        .foregroundStyle(.secondary)
                }
                ForEach(shown) { row($0) }
            }
            .navigationTitle(group.rawValue)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.bold() } }
        }
        .presentationDetents([.medium, .large])
    }

    /// The list's options, then any chosen code it does not offer.
    private var shown: [GisaOption] {
        let offered = Set(options.map(\.code))
        return options + chosen.filter { !offered.contains($0) }.map { GisaOption(code: $0, label: $0) }
    }

    private func row(_ option: GisaOption) -> some View {
        let on = chosen.contains(option.code)
        return Button {
            if on { chosen.removeAll { $0 == option.code } } else { chosen.append(option.code) }
        } label: {
            HStack {
                Text(option.label).foregroundStyle(.primary)
                Spacer()
                if on { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// MARK: - Where the form stands

/// At the top of the form: a returned form's note, and the decision for whoever makes it.
struct GisaReviewStatusSections: View {
    let detail: SubmissionDetail
    @Binding var comment: String
    let working: Bool
    let decide: (SubmissionsAPI.ReviewDecision) -> Void
    let openAssessment: (Int) -> Void
    @State private var confirming: SubmissionsAPI.ReviewDecision?

    var body: some View {
        let status = detail.submission.status
        if status == "REJECTED", let note = detail.submission.reviewComment, !note.isEmpty {
            Section {
                Label {
                    Text("Returned for correction: ").bold() + Text(note)
                } icon: {
                    Image(systemName: "arrow.uturn.backward.circle").foregroundStyle(.red)
                }
                .font(.subheadline)
            }
        }
        if GisaWorkflow.decidesHere(detail) {
            Section {
                NotesField(label: "Review Comment", text: $comment, editable: !working)
                Button("Approve") { confirming = .approve }
                    .bold().disabled(working)
                Button("Return for Correction", role: .destructive) { confirming = .reject }
                    .disabled(working)
            } header: {
                Text("Reviewer Decision")
            } footer: {
                Text(GisaWorkflow.submittedHint(detail))
            }
            .confirmationDialog(confirming == .approve ? "Approve this submission?" : "Return this submission for correction?",
                                isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                                titleVisibility: .visible) {
                if let decision = confirming {
                    Button(decision == .approve ? "Approve" : "Return for Correction",
                           role: decision == .approve ? nil : .destructive) { decide(decision) }
                }
            } message: {
                Text(confirming == .approve ? "The form becomes the approved record." : "The author can edit and resubmit it.")
            }
        } else if status == "SUBMITTED", case .assessment(let id) = GisaWorkflow.route(detail) {
            Section {
                Button(detail.context?.canReview == true ? "Review it on Assessment #\(id)" : "See the review on Assessment #\(id)") {
                    openAssessment(id)
                }
            } footer: {
                Text("\(GisaWorkflow.submittedHint(detail)). The decision is made on the assessment.")
            }
        }
    }
}

/// The end of the form: what review needs, and sending it.
struct GisaSubmitSections: View {
    let detail: SubmissionDetail
    let requirements: [GisaWorkflow.Requirement]
    let canEdit: Bool
    @Binding var comment: String
    let working: Bool
    let fix: (GisaWorkflow.Requirement.Kind) -> Void
    let submit: () -> Void
    let openAssessment: (Int) -> Void
    @State private var confirming = false

    var body: some View {
        if canEdit {
            Section {
                ForEach(requirements) { requirement in
                    Button { fix(requirement.kind) } label: {
                        HStack(alignment: .top) {
                            Image(systemName: requirement.met ? "checkmark.circle.fill" : "exclamationmark.circle")
                                .foregroundStyle(requirement.met ? .green : .orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(requirement.label).foregroundStyle(.primary)
                                if let problem = requirement.problem {
                                    Text(problem).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .disabled(requirement.met)
                    .accessibilityIdentifier("requirement-\(requirement.kind.rawValue)")
                }
            } header: {
                Text("Ready for Review")
            } footer: {
                Text("Tap an item to go to where it is filled in.")
            }
            sendSection
        } else {
            Section("Review") {
                LabeledContent("Status", value: SubmissionLabels.status(detail.submission.status))
                if detail.submission.status == "SUBMITTED" {
                    Text(GisaWorkflow.submittedHint(detail)).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var sendSection: some View {
        switch GisaWorkflow.route(detail) {
        case .assessment(let id):
            Section {
                Button("Save and Open Assessment #\(id)") { openAssessment(id) }
                    .bold().disabled(working)
            } header: {
                Text("Send for Review")
            } footer: {
                Text("This form belongs to Assessment #\(id)\(detail.context.map { " for incident #\($0.incidentId)" } ?? ""). It is sent for review with the assessment, by whoever it is assigned to.")
            }
        case .form:
            let resubmit = detail.submission.status == "REJECTED"
            Section {
                NotesField(label: "Comment (optional)", text: $comment, editable: !working)
                Button(working ? "Working…" : (resubmit ? "Resubmit for Review" : "Submit for Review")) { confirming = true }
                    .bold().disabled(working)
            } header: {
                Text("Send for Review")
            } footer: {
                Text("Saves the form first. It cannot be edited while it is being reviewed.")
            }
            .confirmationDialog(resubmit ? "Resubmit for review?" : "Submit for review?", isPresented: $confirming,
                                titleVisibility: .visible) {
                Button(resubmit ? "Resubmit" : "Submit", action: submit)
            } message: {
                Text("The form is saved and sent. It cannot be edited until it is returned.")
            }
        }
    }
}
