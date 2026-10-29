import ERISKit
import ObjectiveC
import SwiftUI
import WebKit

/// A memo, edited with the web form's own editor (Resources/MemoEditor.html,
/// built from web/src/memoIos), so a memo written on either opens on the other
/// with its formatting, tables, figures and citations intact.
///
/// The page cannot reach the network (its content policy allows nothing but
/// itself) and never sees the session: figure photos are fetched here and
/// handed to it through the `eris-figure:` scheme.
@MainActor
final class MemoEditorController: NSObject, ObservableObject {
    struct Figure: Decodable, Identifiable, Equatable {
        let id: Int
        let label: String
        let caption: String
    }

    struct Load: Encodable {
        let memoKey: String
        let html: String
        let editable: Bool
        let placeholder: String
        let memos: [String: String]
        let dark: Bool
    }

    /// Marks and blocks on at the cursor ("bold", "bulletList", …).
    @Published private(set) var active: Set<String> = []
    @Published private(set) var heading = 0
    @Published private(set) var canUndo = false
    @Published private(set) var canRedo = false
    /// Figures in the memos, to cite.
    @Published private(set) var figures: [Figure] = []
    @Published private(set) var focused = false
    @Published private(set) var loaded = false

    let webView: WKWebView
    var onChange: ((String) -> Void)?
    private var pending: Load?
    private var ready = false

    init(figure: @escaping @Sendable (Int) async throws -> (Data, String)) {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(FigureSchemeHandler(load: figure), forURLScheme: "eris-figure")
        configuration.websiteDataStore = .nonPersistent()
        let content = WKUserContentController()
        configuration.userContentController = content
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.keyboardDismissMode = .interactive
        webView.accessibilityIdentifier = "memo-editor"
        super.init()
        content.add(WeakMessageHandler(self), name: "memo")
        webView.navigationDelegate = self
        if let page = Bundle.main.url(forResource: "MemoEditor", withExtension: "html") {
            webView.loadFileURL(page, allowingReadAccessTo: page)
        }
        Self.hideKeyboardBar(of: webView)
    }

    /// The memo has its own toolbar (with a Done key), so WebKit's bar of
    /// arrows and a checkmark above the keyboard is left off. Done by giving
    /// the page's content view a subclass whose keyboard bar is empty; if
    /// WebKit changes and that view is not found, its bar simply stays.
    private static func hideKeyboardBar(of webView: WKWebView) {
        guard let content = webView.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
              let base = object_getClass(content) else { return }
        let name = "\(NSStringFromClass(base))_ERISMemo"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let made = objc_allocateClassPair(base, name, 0) {
            let none: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            let selector = #selector(getter: UIResponder.inputAccessoryView)
            if let method = class_getInstanceMethod(UIView.self, selector) {
                class_addMethod(made, selector, imp_implementationWithBlock(none), method_getTypeEncoding(method))
            }
            objc_registerClassPair(made)
            subclass = made
        }
        if let subclass { object_setClass(content, subclass) }
    }

    /// Shows a memo; sent once the page is ready.
    func load(_ load: Load) {
        pending = load
        if ready { send(load) }
    }

    func setEditable(_ editable: Bool) {
        evaluate("window.erisMemo.setEditable(\(editable))")
    }

    /// Runs an editor command ("bold", "heading" with 2, "figure" with an id and caption…).
    func run(_ name: String, _ argument: some Encodable = Optional<Int>.none) {
        guard let name = Self.literal(name), let argument = Self.literal(argument) else { return }
        evaluate("window.erisMemo.run(\(name), \(argument))")
    }

    private func send(_ load: Load) {
        guard let literal = Self.literal(load) else { return }
        evaluate("window.erisMemo.load(\(literal))")
    }

    private func evaluate(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// A value as a JavaScript literal (JSON is one).
    private static func literal(_ value: some Encodable) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) }
    }

    fileprivate func received(_ body: Any) {
        guard let message = body as? [String: Any], let type = message["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            if let pending { send(pending) }
        case "loaded":
            loaded = true
        case "change":
            if let html = message["html"] as? String { onChange?(html) }
        case "state":
            active = Set(message["active"] as? [String] ?? [])
            heading = message["heading"] as? Int ?? 0
            canUndo = message["canUndo"] as? Bool ?? false
            canRedo = message["canRedo"] as? Bool ?? false
            if let raw = message["figures"], let data = try? JSONSerialization.data(withJSONObject: raw),
               let decoded = try? JSONDecoder().decode([Figure].self, from: data) {
                figures = decoded
            }
        case "focus":
            focused = message["focused"] as? Bool ?? false
        default:
            break
        }
    }
}

extension MemoEditorController: WKNavigationDelegate {
    /// The page itself loads; nothing else does. A link in a memo opens in Safari.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.isFileURL, url.lastPathComponent == "MemoEditor.html" { return .allow }
        if action.navigationType == .linkActivated, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            await UIApplication.shared.open(url)
        }
        return .cancel
    }
}

/// The message handler holds its target weakly: WebKit keeps handlers alive.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: MemoEditorController?

    init(_ target: MemoEditorController) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { target?.received(message.body) }
    }
}

/// Serves `eris-figure://attachment/<id>` with the photo's bytes, fetched by the app.
private final class FigureSchemeHandler: NSObject, WKURLSchemeHandler {
    private let load: @Sendable (Int) async throws -> (Data, String)
    private var stopped = Set<ObjectIdentifier>()

    init(load: @escaping @Sendable (Int) async throws -> (Data, String)) { self.load = load }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, let id = Int(url.lastPathComponent) else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let key = ObjectIdentifier(task)
        Task { @MainActor in
            do {
                let (data, mimeType) = try await load(id)
                guard !stopped.contains(key) else { return }
                task.didReceive(URLResponse(url: url, mimeType: mimeType, expectedContentLength: data.count, textEncodingName: nil))
                task.didReceive(data)
                task.didFinish()
            } catch {
                if !stopped.contains(key) { task.didFailWithError(error) }
            }
            stopped.remove(key)
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }
}

/// The controller's web view in SwiftUI.
struct MemoWebView: UIViewRepresentable {
    let controller: MemoEditorController

    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
