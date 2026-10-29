import ArcGIS
import ERISKit
import Network
import SwiftUI

/// ArcGIS for the app: the API key and license from ERIS (never built in),
/// applied once, kept for maps offline within the server's window.
@MainActor
final class MapSetup: ObservableObject {
    @Published private(set) var ready = false
    /// A published offline basemap (.mmpk) on this iPhone, if any.
    @Published private(set) var offlineBasemap: URL?
    private var applied = false

    func prepare(api: APIClient, store: OfflineStore) async {
        guard !applied else { return }
        guard let config = try? await api.arcGISConfig(keepingIn: store), config.runtimeEnabled else {
            ready = true  // Maps still open; Esri basemaps need the key, so they may stay blank.
            return
        }
        if let key = config.apiKey, !key.isEmpty, let apiKey = APIKey(key) { ArcGISEnvironment.apiKey = apiKey }
        if let license = config.licenseKey, !license.isEmpty, let licenseKey = LicenseKey(license) {
            _ = try? ArcGISEnvironment.setLicense(with: licenseKey)
        }
        applied = true
        ready = true
        offlineBasemap = Self.keptPackage()
        if let address = config.mmpkUrl, let url = URL(string: address) { await keepPackage(from: url) }
    }

    private static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Maps", isDirectory: true)
    }

    private static func keptPackage() -> URL? {
        let file = folder.appendingPathComponent("basemap.mmpk")
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    /// The published offline basemap: downloaded once, again only when its
    /// address changes; a large download waits for Wi-Fi unless there is none yet.
    private func keepPackage(from url: URL) async {
        let marker = Self.folder.appendingPathComponent("basemap.source")
        let kept = (try? String(contentsOf: marker, encoding: .utf8)) ?? ""
        guard kept != url.absoluteString || offlineBasemap == nil else { return }
        if offlineBasemap != nil, await Self.onExpensiveNetwork() { return }
        do {
            let (download, response) = try await URLSession.shared.download(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return }
            try FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
            var folder = Self.folder
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? folder.setResourceValues(values)
            let target = Self.folder.appendingPathComponent("basemap.mmpk")
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: download, to: target)
            try url.absoluteString.write(to: marker, atomically: true, encoding: .utf8)
            offlineBasemap = target
        } catch {
            // Kept package, if any, stays; tried again next time.
        }
    }

    private static func onExpensiveNetwork() async -> Bool {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in
                monitor.cancel()
                continuation.resume(returning: path.isExpensive || path.isConstrained)
            }
            monitor.start(queue: DispatchQueue(label: "eris.maps.network"))
        }
    }

    /// The offline basemap's first map, for when the online one cannot load.
    func offlineMap() async -> Map? {
        guard let offlineBasemap else { return nil }
        let package = MobileMapPackage(fileURL: offlineBasemap)
        guard (try? await package.load()) != nil else { return nil }
        return package.maps.first
    }
}

/// The technical form's site areas on a map: draw, reshape or remove them
/// around the site's location, stored in `geometry_json` exactly as the web
/// stores them (one Polygon, or a MultiPolygon for several).
struct SiteAreaEditor: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var maps: MapSetup
    let latitude: Double?
    let longitude: Double?
    let initial: [SiteAreas.Area]
    let editable: Bool
    let save: ([SiteAreas.Area]) -> Void

    @StateObject private var model = SiteAreaEditorModel()

    var body: some View {
        NavigationStack {
            MapViewReader { proxy in
                MapView(map: model.map, graphicsOverlays: [model.siteOverlay, model.areasOverlay])
                    .geometryEditor(model.editor)
                    .onSingleTapGesture { _, mapPoint in model.select(at: mapPoint) }
                    .task {
                        await model.start(latitude: latitude, longitude: longitude, areas: initial, proxy: proxy,
                                          offline: { await maps.offlineMap() })
                    }
                    .overlay(alignment: .top) {
                        VStack(spacing: 6) {
                            Text(model.status)
                                .font(.footnote.weight(.semibold))
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(.thinMaterial, in: Capsule())
                                .accessibilityIdentifier("site-area-status")
                            if model.basemapMissing {
                                Text("The base map could not load. Areas can still be drawn around the site.")
                                    .font(.caption).padding(8)
                                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                        .padding(.top, 8).padding(.horizontal)
                    }
            }
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle("Site Areas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                if editable {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            save(model.finishAll())
                            dismiss()
                        }
                        .bold()
                    }
                    ToolbarItemGroup(placement: .bottomBar) { tools }
                }
            }
        }
    }

    @ViewBuilder
    private var tools: some View {
        if model.drawing {
            Button { model.editor.undo() } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
                .disabled(!model.canUndo)
            Button { model.editor.redo() } label: { Label("Redo", systemImage: "arrow.uturn.forward") }
                .disabled(!model.canRedo)
            Spacer()
            if model.editingExisting {
                Button(role: .destructive) { model.removeEditing() } label: { Label("Delete Area", systemImage: "trash") }
            }
            Button("Done") { model.finishArea() }.bold()
        } else {
            Button { model.addArea() } label: { Label("Add Area", systemImage: "plus") }
            Spacer()
        }
    }
}

/// The map, the site marker, the finished areas and the one being drawn.
@MainActor
final class SiteAreaEditorModel: ObservableObject {
    /// Imagery; a plain map in the same projection when the basemap cannot load
    /// (no connection, no key), so areas can still be drawn.
    @Published private(set) var map = Map(basemapStyle: .arcGISImagery)
    @Published private(set) var basemapMissing = false
    let editor = GeometryEditor()
    let siteOverlay = GraphicsOverlay()
    let areasOverlay = GraphicsOverlay()
    @Published private(set) var areas: [SiteAreas.Area] = []
    @Published private(set) var drawing = false
    @Published private(set) var editingExisting = false
    @Published private(set) var canUndo = false
    @Published private(set) var canRedo = false
    /// Where the area being reshaped was in the list, to put it back there.
    private var editingIndex: Int?
    private var watching: Task<Void, Never>?

    private static let red = UIColor(red: 0.84, green: 0.15, blue: 0.16, alpha: 1)
    private static let fill = SimpleFillSymbol(style: .solid, color: red.withAlphaComponent(0.16),
                                               outline: SimpleLineSymbol(style: .solid, color: red, width: 2.5))

    var status: String {
        if drawing { return "Tap to add corners; drag them to adjust" }
        return areas.isEmpty ? "No areas drawn" : "\(SiteAreas.summary(areas)) · tap one to reshape"
    }

    func start(latitude: Double?, longitude: Double?, areas: [SiteAreas.Area], proxy: MapViewProxy,
               offline: () async -> Map?) async {
        self.areas = areas
        redraw()
        var site: Point?
        if let latitude, let longitude {
            let point = Point(x: longitude, y: latitude, spatialReference: .wgs84)
            let halo = SimpleMarkerSymbol(style: .circle, color: Self.red.withAlphaComponent(0.2), size: 30)
            let marker = SimpleMarkerSymbol(style: .diamond, color: Self.red, size: 18)
            marker.outline = SimpleLineSymbol(style: .solid, color: .white, width: 2.5)
            siteOverlay.addGraphics([Graphic(geometry: point, symbol: halo), Graphic(geometry: point, symbol: marker)])
            site = point
        }
        // The areas drawn, else the site at street scale: set on whichever map is shown.
        let polygons = areas.compactMap(Self.polygon)
        let start: Viewpoint? = (polygons.isEmpty ? nil : GeometryEngine.union(of: polygons)?.extent)
            .map { Viewpoint(boundingGeometry: GeometryEngine.buffer(around: $0, distance: 0.0005) ?? $0) }
            ?? site.map { Viewpoint(center: $0, scale: 4_000) }
        map.initialViewpoint = start
        do {
            try await map.load()
        } catch {
            // Offline: the published offline basemap, else a plain grid.
            if let kept = await offline() {
                kept.initialViewpoint = start
                map = kept
            } else {
                let plain = Map(spatialReference: .webMercator)
                plain.initialViewpoint = start
                map = plain
                basemapMissing = true
            }
        }
        watching = Task { [weak self] in
            guard let editor = self?.editor else { return }
            for await _ in editor.$geometry {
                guard let self else { return }
                self.canUndo = self.editor.canUndo
                self.canRedo = self.editor.canRedo
            }
        }
    }

    func addArea() {
        editingIndex = nil
        editingExisting = false
        editor.start(withType: Polygon.self)
        drawing = true
    }

    /// Reshapes the area tapped, when not drawing.
    func select(at mapPoint: Point) {
        guard !drawing, let point = GeometryEngine.project(mapPoint, into: .wgs84) else { return }
        guard let index = areas.firstIndex(where: { area in
            guard let polygon = Self.polygon(area) else { return false }
            return GeometryEngine.doesGeometry(polygon, contain: point)
        }), let polygon = Self.polygon(areas[index]) else { return }
        editingIndex = index
        editingExisting = true
        areas.remove(at: index)
        redraw()
        editor.start(withInitial: polygon)
        drawing = true
    }

    /// Keeps the area drawn (dropped if it has fewer than three corners).
    func finishArea() {
        let geometry = editor.stop()
        drawing = false
        editingExisting = false
        if let polygon = geometry as? Polygon, let area = Self.area(polygon) {
            areas.insert(area, at: min(editingIndex ?? areas.count, areas.count))
        }
        editingIndex = nil
        redraw()
    }

    func removeEditing() {
        _ = editor.stop()
        drawing = false
        editingExisting = false
        editingIndex = nil
        redraw()
    }

    /// Every area, including one still being drawn.
    func finishAll() -> [SiteAreas.Area] {
        if drawing { finishArea() }
        return areas
    }

    private func redraw() {
        areasOverlay.removeAllGraphics()
        areasOverlay.addGraphics(areas.compactMap(Self.polygon).map { Graphic(geometry: $0, symbol: Self.fill) })
    }

    static func polygon(_ area: SiteAreas.Area) -> Polygon? {
        let parts = area.map { ring in
            MutablePart(points: ring.dropLast(ring.first == ring.last ? 1 : 0).map { Point(x: $0[0], y: $0[1], spatialReference: .wgs84) },
                        spatialReference: .wgs84)
        }
        return parts.isEmpty ? nil : Polygon(parts: parts)
    }

    /// A drawn polygon as GeoJSON rings ([lon, lat], each ring closed).
    static func area(_ polygon: Polygon) -> SiteAreas.Area? {
        guard let projected = GeometryEngine.project(polygon, into: .wgs84) as? Polygon else { return nil }
        let rings: [SiteAreas.Ring] = projected.parts.compactMap { part in
            var ring = part.points.map { [$0.x, $0.y] }
            guard ring.count >= 3 else { return nil }
            if ring.first != ring.last { ring.append(ring[0]) }
            return ring
        }
        return rings.isEmpty ? nil : rings
    }
}
