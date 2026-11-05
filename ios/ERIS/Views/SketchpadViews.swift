import PencilKit
import SwiftUI

/// The Sketchpad: draw the site with Apple Pencil or a finger, with the
/// system's pens, eraser, ruler and undo. Saved as a PNG under the Sketchpad
/// section, where it can be placed as a figure in Sketch notes.
struct SketchpadScreen: View {
    let onSave: (Data) -> Void
    let onCancel: () -> Void
    @State private var canvas = PKCanvasView()
    @State private var empty = true
    @State private var confirmingDiscard = false

    var body: some View {
        NavigationStack {
            SketchCanvas(canvas: canvas, empty: $empty)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("Sketch")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            if empty { onCancel() } else { confirmingDiscard = true }
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { if let png = image() { onSave(png) } }
                            .bold()
                            .disabled(empty)
                    }
                }
                .confirmationDialog("Discard this sketch?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                    Button("Discard", role: .destructive, action: onCancel)
                }
        }
    }

    /// The drawing on white, at the screen's scale, with a margin around it.
    private func image() -> Data? {
        let drawing = canvas.drawing
        guard !drawing.strokes.isEmpty else { return nil }
        let bounds = drawing.bounds.insetBy(dx: -24, dy: -24)
        let format = UIGraphicsImageRendererFormat()
        format.scale = max(2, canvas.traitCollection.displayScale)
        let renderer = UIGraphicsImageRenderer(size: bounds.size, format: format)
        let rendered = renderer.image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: bounds.size))
            // Drawn in light mode, so ink stays dark on the white page.
            UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
                drawing.image(from: bounds, scale: format.scale).draw(at: .zero)
            }
        }
        return rendered.pngData()
    }
}

/// PencilKit's canvas with the system tool picker.
private struct SketchCanvas: UIViewRepresentable {
    let canvas: PKCanvasView
    @Binding var empty: Bool
    @State private var picker = PKToolPicker()

    func makeCoordinator() -> Coordinator { Coordinator(empty: $empty) }

    final class Coordinator: NSObject, PKCanvasViewDelegate {
        let empty: Binding<Bool>
        init(empty: Binding<Bool>) { self.empty = empty }
        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) { empty.wrappedValue = canvasView.drawing.strokes.isEmpty }
    }

    func makeUIView(context: Context) -> PKCanvasView {
        canvas.delegate = context.coordinator
        canvas.drawingPolicy = .anyInput
        canvas.backgroundColor = .white
        canvas.overrideUserInterfaceStyle = .light
        canvas.tool = PKInkingTool(.pen, color: .black, width: 4)
        canvas.accessibilityIdentifier = "sketch-canvas"
        picker.setVisible(true, forFirstResponder: canvas)
        picker.addObserver(canvas)
        DispatchQueue.main.async { canvas.becomeFirstResponder() }
        return canvas
    }

    func updateUIView(_ view: PKCanvasView, context: Context) {}
}
