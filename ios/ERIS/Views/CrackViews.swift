import AVFoundation
import ERISKit
import SwiftUI

// MARK: - Context

/// What the Pavement / Ground Status section needs for its cracks; set once
/// by the editor. Cracks are saved on their own, not with the form.
struct GisaCrackContext {
    var submissionId = 0
    var cracks: [Crack] = []
    var canEdit = false
    var adding = false
    var add: (GisaCrackSource) -> Void = { _ in }
    var open: (Crack) -> Void = { _ in }
}

enum GisaCrackSource {
    case camera, library, noPhoto
}

private struct GisaCrackContextKey: EnvironmentKey {
    static let defaultValue = GisaCrackContext()
}

extension EnvironmentValues {
    var gisaCracks: GisaCrackContext {
        get { self[GisaCrackContextKey.self] }
        set { self[GisaCrackContextKey.self] = newValue }
    }
}

/// Opens one crack in the editor's navigation stack.
struct CrackRoute: Hashable, Identifiable {
    let id: Int
}

// MARK: - Pavement / Ground Status

/// Pavement / Ground Status: the yes/no answers, settlement and bulge, and
/// the cracks, each its own record with the same fields (GISA-001 asks to
/// "map cracks": location, length, width, displacements, depth, direction).
struct GisaPavementSection: View {
    @Environment(\.gisaCracks) private var context
    @Binding var editor: GisaEditor
    let canEdit: Bool

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    private func yesNo(_ title: String, _ key: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            ForEach([("YES", "Yes"), ("NO", "No")], id: \.0) { value, label in
                GisaChip(label: label, on: editor.form[key] == value, enabled: canEdit) {
                    editor.set(key, editor.form[key] == value ? "" : value)
                }
            }
        }
    }

    var body: some View {
        Section {
            yesNo("Cracks in pavement or ground", "pavement_ground_cracks")
            yesNo("Indented by rocks", "indented_by_rocks")
            GisaTextField(label: "Settlement (in)", value: binding("settlement_in"), editable: canEdit,
                          keyboard: .decimalPad, error: editor.errors["settlement_in"])
            GisaTextField(label: "Bulge (in)", value: binding("bulge_in"), editable: canEdit,
                          keyboard: .decimalPad, error: editor.errors["bulge_in"])
            GisaSectionPhotos(sectionKey: "pavement_ground_status")
        } header: {
            Text("Pavement / Ground Status")
        }

        Section {
            if context.cracks.isEmpty {
                Text("No cracks recorded. Each crack is recorded on its own, with its own measurements and photo.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(Array(context.cracks.enumerated()), id: \.element.id) { index, crack in
                Button { context.open(crack) } label: {
                    HStack(spacing: 10) {
                        if let photo = crack.photoAttachmentId {
                            AttachmentThumbnail(attachment: AttachmentRef(id: photo))
                                .frame(width: 64, height: 48)
                                .clipped()
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(crack.title(index: index)).font(.headline)
                            Text(crack.summary).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if context.canEdit {
                if context.adding {
                    ProgressView("Adding crack…")
                } else {
                    Menu {
                        Button { context.add(.camera) } label: { Label("Take Photo of Crack", systemImage: "camera") }
                        Button { context.add(.library) } label: {
                            Label("Choose Photo from Library", systemImage: "photo.on.rectangle")
                        }
                        Button { context.add(.noPhoto) } label: { Label("Without a Photo", systemImage: "plus") }
                    } label: {
                        // The whole row opens the menu, not just its words.
                        Label("Add Crack", systemImage: "plus.circle")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                }
            }
        } header: {
            Text("Cracks")
        } footer: {
            Text("Each crack is saved on its own, as soon as you save it, not with the rest of the form.")
        }
    }
}

// MARK: - One crack

/// One crack: its photo with what is drawn on it, and every field GISA-001
/// asks for. Saved on its own; a crack someone else saved since it was opened
/// comes back as they left it.
struct CrackEditorView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let submissionId: Int
    let crack: Crack
    let index: Int
    let canEdit: Bool
    let onSaved: (Crack) -> Void
    let onDeleted: () -> Void
    @State private var draft: CrackDraft
    @State private var image: UIImage?
    @State private var drawing = false
    @State private var saving = false
    @State private var message: String?
    @State private var confirmDelete = false

    init(submissionId: Int, crack: Crack, index: Int, canEdit: Bool, onSaved: @escaping (Crack) -> Void,
         onDeleted: @escaping () -> Void) {
        self.submissionId = submissionId
        self.crack = crack
        self.index = index
        self.canEdit = canEdit
        self.onSaved = onSaved
        self.onDeleted = onDeleted
        _draft = State(initialValue: CrackDraft(crack))
    }

    private var changes: Result<[String: JSONValue], InputProblem> { draft.changes(from: crack) }
    private var dirty: Bool {
        if case .success(let changes) = changes { return !changes.isEmpty }
        return true
    }

    var body: some View {
        Form {
            if crack.photoAttachmentId != nil {
                Section {
                    CrackPhotoView(image: image, shapes: draft.annotations?.shapes ?? [], crack: crack)
                        .listRowInsets(EdgeInsets())
                    if canEdit && image != nil {
                        Button { drawing = true } label: { Label("Draw on Photo", systemImage: "pencil.tip.crop.circle") }
                    }
                }
            }
            Section("Crack") {
                LabeledTextField(label: "Name", text: $draft.label, prompt: "Crack \(index + 1)")
                ForEach(CrackMeasure.allCases) { measure in
                    LabeledTextField(label: "\(measure.shortLabel) (\(measure.unit))", text: $draft[measure], keyboard: .decimalPad)
                }
            }
            Section {
                LabeledTextField(label: "Direction (°)", text: $draft.trendDeg, keyboard: .decimalPad)
                if let runs = Crack.trendText(typedNumber(draft.trendDeg)) { Text("Runs \(runs)").foregroundStyle(.secondary) }
                Picker("Orientation to the roadway", selection: $draft.orientation) {
                    Text("Not set").tag(CrackOrientation?.none)
                    ForEach(CrackOrientation.allCases) { Text($0.label).tag(CrackOrientation?.some($0)) }
                }
            } header: {
                Text("Direction")
            } footer: {
                Text("Degrees from north that the crack runs; a line runs both ways, so 200° is the same as 20°.")
            }
            Section {
                LabeledTextField(label: "Latitude", text: $draft.latitude, keyboard: .numbersAndPunctuation)
                LabeledTextField(label: "Longitude", text: $draft.longitude, keyboard: .numbersAndPunctuation)
            } header: {
                Text("Location")
            } footer: {
                if let saved = crack.locationText { Text("Saved: \(saved)") }
            }
            Section("Notes") {
                TextField("Notes", text: $draft.notes, axis: .vertical).lineLimit(3...8)
            }
            if let message { Section { Text(message).foregroundStyle(.red) } }
            if canEdit {
                Section {
                    Button("Delete Crack", role: .destructive) { confirmDelete = true }
                } footer: {
                    Text("Its photo stays on the form.")
                }
            }
        }
        .disabled(!canEdit || saving)
        .navigationTitle(crack.title(index: index))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canEdit {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(saving || !dirty)
            }
        }
        .keyboardDoneButton()
        .task { await loadImage() }
        .fullScreenCover(isPresented: $drawing) {
            if let image {
                CrackDrawingView(image: image, crack: crack, shapes: draft.annotations?.shapes ?? []) { shapes in
                    draft.annotations = shapes.isEmpty && crack.annotations == nil ? nil : CrackAnnotations(shapes: shapes)
                    drawing = false
                } onCancel: { drawing = false }
            }
        }
        .confirmationDialog("Delete \(crack.title(index: index))?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Crack", role: .destructive) { Task { await delete() } }
        } message: {
            Text("Its photo stays on the form.")
        }
    }

    private func loadImage() async {
        guard let id = crack.photoAttachmentId, image == nil,
              let link = try? await SubmissionsAPI(api: model.api).attachmentLink(id),
              let url = URL(string: link.downloadUrl) else { return }
        // A presigned link: fetched without the ERIS session.
        if let (data, _) = try? await URLSession.shared.data(from: url) { image = UIImage(data: data) }
    }

    private func save() async {
        switch changes {
        case .failure(let problem):
            message = problem.message
        case .success(let body):
            // Saved means done typing: put the keyboard away.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            saving = true
            defer { saving = false }
            do {
                let saved = try await SubmissionsAPI(api: model.api).updateCrack(submissionId, crackId: crack.id,
                                                                                 revision: crack.revision, changes: body)
                message = nil
                onSaved(saved)
            } catch let conflict as CrackConflict {
                if let theirs = conflict.theirs {
                    onSaved(theirs)
                    draft = CrackDraft(theirs)
                }
                message = "Someone else saved this crack after you opened it. It now shows their version; make your change again."
            } catch {
                message = model.handle(error)
            }
        }
    }

    private func delete() async {
        saving = true
        defer { saving = false }
        do {
            try await SubmissionsAPI(api: model.api).deleteCrack(submissionId, crackId: crack.id)
            onDeleted()
            dismiss()
        } catch {
            message = model.handle(error)
        }
    }
}

/// The typed direction as a number for its preview; nil when blank or not a number.
private func typedNumber(_ text: String) -> Double? {
    let raw = text.trimmingCharacters(in: .whitespaces)
    return raw.isEmpty ? nil : Double(raw)
}

/// A label on the left and its value field on the right; tapping anywhere
/// on the row puts the cursor in the field.
struct LabeledTextField: View {
    let label: String
    @Binding var text: String
    var prompt = ""
    var keyboard: UIKeyboardType = .default
    @FocusState private var focused: Bool

    var body: some View {
        LabeledContent(label) {
            // Narrow, so the label is not cut short.
            TextField(label, text: $text, prompt: Text(prompt))
                .multilineTextAlignment(.trailing)
                .keyboardType(keyboard)
                .focused($focused)
                .frame(maxWidth: 140)
        }
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
    }
}

// MARK: - Photo and drawing

/// The rectangle a photo fills when fitted into `size`.
private func fittedRect(_ image: CGSize, in size: CGSize) -> CGRect {
    AVMakeRect(aspectRatio: image, insideRect: CGRect(origin: .zero, size: size))
}

/// A crack's photo with its shapes and labels drawn over it.
struct CrackPhotoView: View {
    let image: UIImage?
    let shapes: [CrackShape]
    let crack: Crack

    var body: some View {
        if let image {
            GeometryReader { geometry in
                let rect = fittedRect(image.size, in: geometry.size)
                ZStack(alignment: .topLeading) {
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                    CrackShapesOverlay(shapes: shapes, crack: crack, rect: rect)
                }
            }
            .aspectRatio(image.size, contentMode: .fit)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Photo of the crack. " + shapes.compactMap { crack.words(for: $0) }.joined(separator: ". "))
        } else {
            Color.gray.opacity(0.15).aspectRatio(4 / 3, contentMode: .fit).overlay(ProgressView())
        }
    }
}

/// Paths, two-headed arrows and labels in a photo's fitted rectangle.
struct CrackShapesOverlay: View {
    let shapes: [CrackShape]
    let crack: Crack
    let rect: CGRect
    var inProgress: [CGPoint] = []

    private func point(_ pair: [Double]) -> CGPoint {
        CGPoint(x: rect.minX + pair[0] * rect.width, y: rect.minY + pair[1] * rect.height)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                for shape in shapes where shape.type != .label {
                    let points = (shape.points ?? []).filter { $0.count == 2 }.map(point)
                    guard points.count >= 2 else { continue }
                    var path = Path()
                    path.addLines(points)
                    let color = Color(hex: shape.color) ?? .yellow
                    context.stroke(path, with: .color(.black.opacity(0.5)), style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
                    context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
                    if shape.type == .arrow {
                        for (tip, from) in [(points[points.count - 1], points[points.count - 2]), (points[0], points[1])] {
                            context.fill(arrowHead(tip: tip, from: from), with: .color(color))
                        }
                    }
                }
                if inProgress.count >= 2 {
                    var path = Path()
                    path.addLines(inProgress)
                    context.stroke(path, with: .color(.yellow.opacity(0.8)), style: StrokeStyle(lineWidth: 3.5, lineCap: .round, dash: [6, 4]))
                }
            }
            ForEach(Array(shapes.enumerated()), id: \.offset) { _, shape in
                if let words = crack.words(for: shape), let at = labelPoint(shape) {
                    Text(words)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 4))
                        .fixedSize()
                        .position(at)
                }
            }
        }
        .allowsHitTesting(false)
    }

    private func labelPoint(_ shape: CrackShape) -> CGPoint? {
        if shape.type == .label, let at = shape.at, at.count == 2 { return point(at) }
        guard let points = shape.points, !points.isEmpty else { return nil }
        return point(points[points.count / 2])
    }

    private func arrowHead(tip: CGPoint, from: CGPoint) -> Path {
        let angle = atan2(tip.y - from.y, tip.x - from.x)
        let length: CGFloat = 14, spread: CGFloat = .pi / 7
        var path = Path()
        path.move(to: tip)
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle - spread), y: tip.y - length * sin(angle - spread)))
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle + spread), y: tip.y - length * sin(angle + spread)))
        path.closeSubpath()
        return path
    }
}

/// Drawing on a crack's photo: trace the crack, mark an opening or offset
/// with a two-headed arrow, and place labels that show a measurement.
struct CrackDrawingView: View {
    let image: UIImage
    let crack: Crack
    let onDone: ([CrackShape]) -> Void
    let onCancel: () -> Void
    @State private var shapes: [CrackShape]
    @State private var tool = Tool.path
    @State private var stroke: [CGPoint] = []
    @State private var pendingLabel: [Double]?

    enum Tool: String, CaseIterable, Identifiable {
        case path = "Trace", arrow = "Arrow", label = "Label"
        var id: String { rawValue }
    }

    init(image: UIImage, crack: Crack, shapes: [CrackShape], onDone: @escaping ([CrackShape]) -> Void,
         onCancel: @escaping () -> Void) {
        self.image = image
        self.crack = crack
        self.onDone = onDone
        self.onCancel = onCancel
        _shapes = State(initialValue: shapes)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Picker("Tool", selection: $tool) {
                    ForEach(Tool.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                Text(hint).font(.footnote).foregroundStyle(.secondary).padding(.horizontal)
                GeometryReader { geometry in
                    let rect = fittedRect(image.size, in: geometry.size)
                    ZStack(alignment: .topLeading) {
                        Image(uiImage: image).resizable().scaledToFit()
                            .frame(width: geometry.size.width, height: geometry.size.height)
                        CrackShapesOverlay(shapes: shapes, crack: crack, rect: rect, inProgress: stroke)
                    }
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            guard rect.contains(value.location) else { return }
                            if tool == .arrow { stroke = [stroke.first ?? value.location, value.location] }
                            else if tool == .path { stroke.append(value.location) }
                        }
                        .onEnded { value in finish(at: value.location, in: rect) })
                    .accessibilityLabel("Photo to draw on")
                }
                HStack {
                    Button { if !shapes.isEmpty { shapes.removeLast() } } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
                        .disabled(shapes.isEmpty)
                    Spacer()
                    Button(role: .destructive) { shapes.removeAll() } label: { Label("Clear", systemImage: "trash") }
                        .disabled(shapes.isEmpty)
                }
                .padding(.horizontal)
            }
            .padding(.vertical)
            .navigationTitle("Draw on Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { onDone(shapes) } }
            }
            .confirmationDialog("What should this label show?", isPresented: Binding(
                get: { pendingLabel != nil }, set: { if !$0 { pendingLabel = nil } }), titleVisibility: .visible) {
                ForEach(CrackMeasure.allCases) { measure in
                    Button("\(measure.label) (\(crack.text(measure) ?? "not measured yet"))") { placeLabel(measure: measure) }
                }
            }
        }
    }

    private var hint: String {
        switch tool {
        case .path: return "Drag along the crack to trace it."
        case .arrow: return "Drag across the crack to mark an opening or offset."
        case .label: return "Tap where a label should go, then choose the measurement it shows."
        }
    }

    private func normalized(_ point: CGPoint, in rect: CGRect) -> [Double] {
        [Double(min(max((point.x - rect.minX) / rect.width, 0), 1)), Double(min(max((point.y - rect.minY) / rect.height, 0), 1))]
    }

    private func finish(at location: CGPoint, in rect: CGRect) {
        defer { stroke = [] }
        switch tool {
        case .label:
            guard rect.contains(location) else { return }
            pendingLabel = normalized(location, in: rect)
        case .path, .arrow:
            // Thin a freehand trace to every few points; the server keeps at most 500.
            let points = stroke.enumerated().filter { $0.offset % 3 == 0 || $0.offset == stroke.count - 1 }.map(\.element)
            guard points.count >= 2 else { return }
            shapes.append(CrackShape(type: tool == .arrow ? .arrow : .path,
                                     points: Array(points.prefix(500)).map { normalized($0, in: rect) }))
        }
    }

    private func placeLabel(measure: CrackMeasure) {
        guard let at = pendingLabel else { return }
        shapes.append(CrackShape(type: .label, at: at, measure: measure))
        pendingLabel = nil
    }
}

extension Color {
    /// "#FF3B30" as a colour, or nil.
    init?(hex: String?) {
        guard let hex, hex.count == 7, hex.first == "#", let value = Int(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
                  blue: Double(value & 0xFF) / 255)
    }
}

extension View {
    /// A Done button above the keyboard: the number pads have no Return key.
    func keyboardDoneButton() -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                }
            }
        }
    }
}
