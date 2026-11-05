import ERISKit
import SwiftUI

/// For a chief: open work by who holds it, with whoever moved on first. Their work
/// can be spread around, or all given to whoever took over.
struct MoveWorkView: View {
    @EnvironmentObject private var model: AppModel
    let done: (String) -> Void
    @State private var workload = Workload()
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if loaded && workload.groups.isEmpty {
                Text("Nobody holds open work you can move.").foregroundStyle(.secondary)
            }
            ForEach(workload.groups) { group in
                NavigationLink(value: group) {
                    HStack {
                        Text(group.holderLine)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(group.left ? Color.orange : .primary)
                        Spacer()
                        Text("\(group.items.count) open").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Move Work")
        // On the stack's path, so finishing comes all the way back to My Work.
        .navigationDestination(for: HeldWork.self) { MoveGroupView(group: $0, done: done) }
        .task {
            do {
                workload = try await AssessmentsAPI(api: model.api).workload()
                error = nil
            } catch {
                self.error = model.handle(error)
            }
            loaded = true
        }
    }
}

/// One person's open work: choose which of it moves, and to whom. Each move is an
/// ordinary hand-off, so the form, its photos and its history stay with the assessment.
private struct MoveGroupView: View {
    @EnvironmentObject private var model: AppModel
    let group: HeldWork
    let done: (String) -> Void
    @State private var chosen: Set<Int> = []
    @State private var options = RoutingOptions(groups: [], items: [])
    @State private var target = PersonPicker.initialValue()
    @State private var notes = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            Section("Assessments to move") {
                ForEach(group.items) { item in
                    Button {
                        if chosen.contains(item.id) { chosen.remove(item.id) } else { chosen.insert(item.id) }
                    } label: {
                        HStack {
                            Image(systemName: chosen.contains(item.id) ? "checkmark.circle.fill" : "circle")
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Assessment #\(item.id)").font(.subheadline.weight(.semibold))
                                Text(item.title ?? RoleModel.assessmentStateLabel(item.state)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .foregroundStyle(.primary)
                }
            }
            PersonPickerSections(title: group.kind.pickerTitle, sections: options.sections,
                                 empty: "Nobody else can take this work.", selection: $target)
            Section("Note") {
                TextField("Optional", text: $notes, axis: .vertical)
            }
            Section {
                Button(chosen.count == 1 ? "Move 1 assessment" : "Move \(chosen.count) assessments", action: move)
                    .disabled(busy || target == nil || chosen.isEmpty)
                    .accessibilityIdentifier("move-confirm")
            }
        }
        .navigationTitle(group.holder.fullName ?? "Nobody")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            chosen = Set(group.items.map(\.id))
            do {
                options = try await AssessmentsAPI(api: model.api).moveOptions(group)
            } catch {
                self.error = model.handle(error)
            }
        }
    }

    private func move() {
        guard let target else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let name = options.items.first { $0.id == target }?.fullName ?? "them"
                let ids = group.items.map(\.id).filter(chosen.contains)
                let result = try await AssessmentsAPI(api: model.api).move(ids, to: target, kind: group.kind, notes: notes)
                if result.moved.isEmpty {
                    error = result.outcome(to: name)
                } else {
                    done(result.outcome(to: name))
                }
            } catch {
                self.error = model.handle(error)
            }
        }
    }
}
