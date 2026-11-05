import ERISKit
import SwiftUI

/// Who else has the form open, what they saved, and fields waiting for a
/// choice. Shown only when there is something to say.
struct FormPresenceSection: View {
    let others: [PresenceOther]
    let notice: String?
    let pending: GisaEditor.Pending?
    let choose: () -> Void

    var body: some View {
        let people = Presence.people(others)
        if !people.isEmpty || notice != nil || pending != nil {
            Section {
                if !people.isEmpty {
                    HStack(spacing: 8) {
                        HStack(spacing: -6) {
                            ForEach(people.prefix(4)) { PresenceCircle(person: $0) }
                        }
                        Text(Presence.sentence(people)).font(.subheadline)
                    }
                    .accessibilityElement(children: .combine)
                }
                if let notice {
                    Label(notice, systemImage: "arrow.triangle.2.circlepath").font(.subheadline)
                }
                if let pending {
                    Button(action: choose) {
                        Label("\(pending.savedBy ?? "Someone else") also changed \(pending.conflicts.map(\.label).joined(separator: ", ")). Choose which to keep.",
                              systemImage: "exclamationmark.triangle")
                    }
                    .tint(.orange)
                }
            }
        }
    }
}

/// A person's initials in their colour, as on the web form.
struct PresenceCircle: View {
    let person: PresenceOther

    var body: some View {
        Text(Presence.initials(person.name))
            .font(.caption2.bold())
            .foregroundStyle(.white)
            .frame(width: 26, height: 26)
            .background(Circle().fill(Color(hex: Presence.color(person.userId)) ?? .gray))
            .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
            .accessibilityLabel(person.name)
    }
}

/// Fields this person and someone else both changed: for each, keep theirs or mine.
struct FormConflictSheet: View {
    @Environment(\.dismiss) private var dismiss
    let pending: GisaEditor.Pending
    let apply: (Set<String>) -> Void
    @State private var takeTheirs: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("\(pending.savedBy ?? "Someone else") saved changes to fields you are also changing. For each, choose which version to keep. Nothing is saved until you do.")
                        .font(.callout)
                }
                ForEach(pending.conflicts) { conflict in
                    Section(conflict.label) {
                        choice(conflict, theirs: false)
                        choice(conflict, theirs: true)
                    }
                }
            }
            .navigationTitle("Changed by both")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Later") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { apply(takeTheirs) }.bold() }
            }
        }
    }

    private func choice(_ conflict: GisaEditor.FieldConflict, theirs: Bool) -> some View {
        let chosen = takeTheirs.contains(conflict.key) == theirs
        let value = theirs ? conflict.theirs : conflict.mine
        return Button {
            if theirs { takeTheirs.insert(conflict.key) } else { takeTheirs.remove(conflict.key) }
        } label: {
            HStack(alignment: .top) {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(theirs ? "Keep \(pending.savedBy ?? "theirs")'s" : "Keep mine").font(.subheadline.bold())
                    Text(value.isEmpty ? "(blank)" : value).foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("\(conflict.key)-\(theirs ? "theirs" : "mine")")
    }
}

/// The save's outcome and the choice between versions, on whichever screen is
/// showing: the form, or a memo opened from it.
struct FormPrompts: ViewModifier {
    @Binding var alert: GisaEditor.SaveProblem?
    @Binding var choosing: Bool
    let pending: GisaEditor.Pending?
    let resolve: (Set<String>) -> Void

    func body(content: Content) -> some View {
        content
            .alert(alert?.title ?? "", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
                Button("OK", role: .cancel) { alert = nil }
            } message: {
                Text(alert?.message ?? "")
            }
            .sheet(isPresented: $choosing) {
                if let pending { FormConflictSheet(pending: pending, apply: resolve) }
            }
    }
}
