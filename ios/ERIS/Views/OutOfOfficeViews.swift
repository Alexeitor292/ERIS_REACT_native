import ERISKit
import SwiftUI

/// Account › Out of office: name someone to act for you between two dates. It ends
/// by itself after the last day, and what they do is recorded under both names.
struct OutOfOfficeView: View {
    @EnvironmentObject private var model: AppModel
    let me: Me
    @State private var overview: DelegationOverview?
    @State private var people: [Delegation.Person] = []
    @State private var candidates: [DelegationCandidate] = []
    @State private var forPerson: Int?
    @State private var delegate: Int?
    @State private var first = Date()
    @State private var last = Date()
    @State private var note = ""
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var actions: (id: Int, items: [DelegatedAction])?

    private var api: DelegationsAPI { DelegationsAPI(api: model.api) }
    private var problem: String? { DelegationDates.problem(delegate: delegate, first: first, last: last) }

    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            if let notice { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.green).font(.subheadline) }
            Section {
                if !people.isEmpty {
                    Picker("For", selection: $forPerson) {
                        Text("Myself").tag(Int?.none)
                        ForEach(people, id: \.id) { Text($0.fullName).tag(Int?.some($0.id)) }
                    }
                }
                Picker("Who will act", selection: $delegate) {
                    Text("Select a person").tag(Int?.none)
                    ForEach(candidates) { Text($0.label).tag(Int?.some($0.id)) }
                }
                .accessibilityIdentifier("delegate-picker")
                DatePicker("First day", selection: $first, displayedComponents: .date)
                DatePicker("Last day", selection: $last, in: first..., displayedComponents: .date)
                TextField("Note (optional)", text: $note, axis: .vertical)
                Button("Set Out of Office", action: set)
                    .disabled(busy || problem != nil)
                    .accessibilityIdentifier("set-out-of-office")
            } header: {
                Text("Set who acts for you")
            } footer: {
                Text("Someone in the same office, or on the same district's lists. They can switch to acting for you and see and do your work.")
            }
            if let overview, !overview.given.isEmpty {
                Section("Acting for you") { ForEach(overview.given) { row($0, other: $0.delegate.fullName) } }
            }
            if let overview, !overview.received.isEmpty {
                Section("You act for") { ForEach(overview.received) { row($0, other: $0.delegator.fullName) } }
            }
        }
        .navigationTitle("Out of Office")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: forPerson) { _, person in
            delegate = nil
            Task { candidates = (try? await api.candidates(forUser: person)) ?? [] }
        }
    }

    private func row(_ item: Delegation, other: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(other).font(.subheadline.weight(.semibold))
                Spacer()
                Text(item.statusLabel).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            Text(item.periodLabel).font(.caption).foregroundStyle(.secondary)
            if let note = item.note { Text(note).font(.caption).foregroundStyle(.secondary) }
            if item.actionCount > 0 {
                Button("\(item.actionCount) \(item.actionCount == 1 ? "action" : "actions")") { showActions(item.id) }
                    .buttonStyle(.borderless).font(.caption)
            }
            if let actions, actions.id == item.id {
                ForEach(Array(actions.items.enumerated()), id: \.offset) { _, action in
                    Text([ServerDate.display(action.createdAt), action.actorName, action.label].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            if item.isOpen {
                Button(item.status == "ACTIVE" ? "End Now" : "Cancel", role: .destructive) { cancel(item.id) }
                    .buttonStyle(.borderless).font(.caption.weight(.semibold))
            }
        }
    }

    private func load() async {
        do {
            overview = try await api.overview()
            error = nil
        } catch {
            self.error = model.handle(error)
        }
        people = (try? await api.people()) ?? []
        candidates = (try? await api.candidates(forUser: forPerson)) ?? []
    }

    private func set() {
        guard let delegate else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await api.create(delegate: delegate, first: first, last: last, note: note, forUser: forPerson)
                self.delegate = nil
                note = ""
                notice = "Set. They have been told."
                error = nil
                await load()
                await model.refreshMe()
            } catch {
                notice = nil
                self.error = model.handle(error)
            }
        }
    }

    private func cancel(_ id: Int) {
        Task {
            do {
                try await api.cancel(id)
                await load()
                await model.refreshMe()
            } catch {
                self.error = model.handle(error)
            }
        }
    }

    private func showActions(_ id: Int) {
        if actions?.id == id { actions = nil; return }
        Task {
            if let items = try? await api.actions(id) { actions = (id, items) }
        }
    }
}
