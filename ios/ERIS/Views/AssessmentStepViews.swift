import ERISKit
import SwiftUI

/// A memo to open from the Assessment step.
struct MemoRoute: Hashable, Identifiable {
    let key: String
    var id: String { key }
}

/// Step 3, Assessment, as the web form's memos: Observations, Geotechnical
/// assessment, Recommendations and Sketch notes as documents, each opening
/// full screen; notes on earlier incidents and maintenance as plain text.
struct GisaAssessmentSections: View {
    @Binding var editor: GisaEditor
    let canEdit: Bool
    /// Memo key -> someone else writing it.
    let writers: [String: PresenceOther]
    let open: (String) -> Void

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    var body: some View {
        ForEach(MemoContent.keys, id: \.self) { key in
            Section {
                MemoRow(key: key, html: editor.form["\(key)_html"], writer: writers[key], edited: isEdited(key)) { open(key) }
                GisaSectionPhotos(sectionKey: MemoContent.photoSection(key))
            } header: {
                Text(MemoContent.label(key))
            } footer: {
                Text(MemoContent.purpose(key))
            }
        }
        Section {
            NotesField(label: "Notes on earlier incidents", text: binding("record_of_event_notes"), editable: canEdit)
            NotesField(label: "Notes on maintenance", text: binding("maintenance_history_notes"), editable: canEdit)
            GisaSectionPhotos(sectionKey: "record_of_event")
        } header: {
            Text("Record of incidents")
        } footer: {
            Text("Earlier incidents at this location, and the maintenance done for them.")
        }
    }

    private func isEdited(_ key: String) -> Bool {
        editor.form["\(key)_html"] != editor.base.form["\(key)_html"]
    }
}

/// A memo in the list: its opening words, and who is writing it.
private struct MemoRow: View {
    let key: String
    let html: String
    let writer: PresenceOther?
    let edited: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 6) {
                let preview = MemoContent.preview(html)
                Text(preview.isEmpty ? "Not written yet" : preview)
                    .foregroundStyle(preview.isEmpty ? .secondary : .primary)
                    .lineLimit(3)
                if let writer {
                    Label("\(writer.name) is writing this memo", systemImage: "lock.fill")
                        .font(.caption).foregroundStyle(.orange)
                } else if edited {
                    Label("Changed, not saved yet", systemImage: "pencil").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("memo-\(key)")
    }
}

/// A plain multi-line note.
private struct NotesField: View {
    let label: String
    @Binding var text: String
    let editable: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField(label, text: $text, prompt: Text(""), axis: .vertical)
                .lineLimit(3...10)
                .disabled(!editable)
                .accessibilityLabel(label)
        }
    }
}

/// One memo, full screen, in the web form's editor, with a toolbar for
/// formatting, figures and citations. Read-only while someone else writes it.
struct MemoEditorScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var controller: MemoEditorController
    @Binding var editor: GisaEditor
    let key: String
    let canEdit: Bool
    let writer: PresenceOther?
    /// The form's photos, to place as figures.
    let photos: [AttachmentRef]
    let typed: () -> Void
    let save: () async -> Void
    @State private var lastSent: String?
    @State private var choosingFigure = false
    @State private var saving = false

    init(editor: Binding<GisaEditor>, key: String, canEdit: Bool, writer: PresenceOther?, photos: [AttachmentRef],
         figure: @escaping @Sendable (Int) async throws -> (Data, String), typed: @escaping () -> Void,
         save: @escaping () async -> Void) {
        _controller = StateObject(wrappedValue: MemoEditorController(figure: figure))
        _editor = editor
        self.key = key
        self.canEdit = canEdit
        self.writer = writer
        self.photos = photos
        self.typed = typed
        self.save = save
    }

    private var htmlKey: String { "\(key)_html" }
    private var editable: Bool { canEdit && writer == nil }

    var body: some View {
        MemoWebView(controller: controller)
            .ignoresSafeArea(.container, edges: .bottom)
            .safeAreaInset(edge: .top) { lockNotice }
            .safeAreaInset(edge: .bottom) { if editable { MemoToolbar(controller: controller, choosingFigure: $choosingFigure) } }
            .navigationTitle(MemoContent.label(key))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .tabBar)
            .toolbar {
                if canEdit {
                    Button(saving ? "Saving…" : "Save") {
                        Task {
                            saving = true
                            controller.run("done")
                            await save()
                            saving = false
                        }
                    }
                    .disabled(saving)
                }
            }
            .sheet(isPresented: $choosingFigure) {
                FigurePicker(photos: photos) { photo, caption in
                    choosingFigure = false
                    controller.run("figure", FigureInsert(id: photo.id, caption: caption))
                }
            }
            .onAppear(perform: start)
            .onChange(of: editor.form[htmlKey]) { _, html in
                // Someone else's saved memo arrived while this one was untouched.
                if html != lastSent { load() }
            }
            .onChange(of: editable) { _, now in controller.setEditable(now) }
    }

    @ViewBuilder private var lockNotice: some View {
        if let writer {
            Label("\(writer.name) is writing this memo. It opens again once they save or stop.", systemImage: "lock.fill")
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(.orange.opacity(0.15))
        }
    }

    private func start() {
        controller.onChange = { html in
            lastSent = html
            editor.set(htmlKey, html)
            typed()
        }
        load()
    }

    private func load() {
        lastSent = editor.form[htmlKey]
        let memos = Dictionary(uniqueKeysWithValues: MemoContent.keys.map { ($0, editor.form["\($0)_html"]) })
        controller.load(.init(memoKey: key, html: editor.form[htmlKey], editable: editable,
                              placeholder: "Write the \(MemoContent.label(key).lowercased())…", memos: memos,
                              dark: colorScheme == .dark))
    }
}

private struct FigureInsert: Encodable {
    let id: Int
    let caption: String
}

/// The formatting bar above the keyboard.
private struct MemoToolbar: View {
    @ObservedObject var controller: MemoEditorController
    @Binding var choosingFigure: Bool

    private static let symbols = ["°", "±", "×", "≈", "≤", "≥", "′", "″", "²", "³", "½", "Δ", "θ", "α", "β", "γ", "φ", "→", "✓"]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                tool("arrow.uturn.backward", "Undo", "undo", on: false).disabled(!controller.canUndo)
                tool("arrow.uturn.forward", "Redo", "redo", on: false).disabled(!controller.canRedo)
                Divider().frame(height: 24)
                tool("bold", "Bold", "bold")
                tool("italic", "Italic", "italic")
                tool("underline", "Underline", "underline")
                tool("strikethrough", "Strikethrough", "strike")
                tool("highlighter", "Highlight", "highlight")
                headingMenu
                Divider().frame(height: 24)
                tool("list.bullet", "Bulleted list", "bulletList")
                tool("list.number", "Numbered list", "orderedList")
                tool("checklist", "Checklist", "taskList")
                tool("decrease.indent", "Decrease indent", "outdent", on: false)
                tool("increase.indent", "Increase indent", "indent", on: false)
                tool("text.quote", "Quote", "blockquote", command: "quote")
                Divider().frame(height: 24)
                figureMenu
                tableMenu
                symbolMenu
                tool("textformat", "Clear formatting", "clear", on: false)
                tool("keyboard.chevron.compact.down", "Done", "done", on: false)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }

    private func tool(_ icon: String, _ label: String, _ name: String, command: String? = nil, on: Bool = true) -> some View {
        let active = on && controller.active.contains(name)
        return Button { controller.run(command ?? name) } label: {
            Image(systemName: icon)
                .frame(width: 34, height: 34)
                .background(active ? Color.accentColor.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private var headingMenu: some View {
        Menu {
            Button("Normal text") { controller.run("heading", 0) }
            ForEach(1...4, id: \.self) { level in
                Button("Heading \(level)") { controller.run("heading", level) }
            }
        } label: {
            Image(systemName: "textformat.size").frame(width: 34, height: 34)
                .background(controller.heading > 0 ? Color.accentColor.opacity(0.2) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .accessibilityLabel("Text style")
    }

    private var figureMenu: some View {
        Menu {
            Button("Insert a photo as a figure", systemImage: "photo") { choosingFigure = true }
            if controller.figures.isEmpty {
                Text("Figures in the memos can be cited here")
            } else {
                Section("Cite a figure") {
                    ForEach(controller.figures) { figure in
                        Button("Figure \(figure.label)\(figure.caption.isEmpty ? "" : ". \(figure.caption)")") {
                            controller.run("cite", figure.id)
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "photo.on.rectangle").frame(width: 34, height: 34)
        }
        .accessibilityLabel("Figures")
    }

    private var tableMenu: some View {
        Menu {
            Button("Insert table") { controller.run("table") }
            if controller.active.contains("table") {
                Button("Add row") { controller.run("addRow") }
                Button("Add column") { controller.run("addColumn") }
                Button("Delete row", role: .destructive) { controller.run("deleteRow") }
                Button("Delete column", role: .destructive) { controller.run("deleteColumn") }
                Button("Delete table", role: .destructive) { controller.run("deleteTable") }
            }
        } label: {
            Image(systemName: "tablecells").frame(width: 34, height: 34)
        }
        .accessibilityLabel("Table")
    }

    private var symbolMenu: some View {
        Menu {
            ForEach(Self.symbols, id: \.self) { symbol in
                Button(symbol) { controller.run("symbol", symbol) }
            }
        } label: {
            Image(systemName: "function").frame(width: 34, height: 34)
        }
        .accessibilityLabel("Symbols")
    }
}

/// One of the form's photos, with a caption, to place as a figure.
private struct FigurePicker: View {
    @Environment(\.dismiss) private var dismiss
    let photos: [AttachmentRef]
    let insert: (AttachmentRef, String) -> Void
    @State private var chosen: AttachmentRef?
    @State private var caption = ""

    var body: some View {
        NavigationStack {
            Form {
                if photos.isEmpty {
                    Text("The form has no photos yet. Add them under the memo or in any section, then place them here.")
                        .foregroundStyle(.secondary)
                } else {
                    Section("Photo") {
                        ScrollView(.horizontal) {
                            HStack {
                                ForEach(photos) { photo in
                                    Button { chosen = photo } label: {
                                        AttachmentThumbnail(attachment: photo)
                                            .overlay(RoundedRectangle(cornerRadius: 8)
                                                .stroke(chosen == photo ? Color.accentColor : .clear, lineWidth: 3))
                                    }
                                    .accessibilityLabel(photo.fileName ?? "Photo \(photo.id)")
                                }
                            }
                        }
                    }
                    Section("Caption") {
                        TextField("What the photo shows", text: $caption, axis: .vertical)
                    }
                }
            }
            .navigationTitle("Insert figure")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Insert") { if let chosen { insert(chosen, caption.trimmingCharacters(in: .whitespacesAndNewlines)) } }
                        .disabled(chosen == nil)
                }
            }
        }
    }
}
