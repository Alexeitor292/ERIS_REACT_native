import ERISKit
import SceneKit
import SwiftUI

/// The site's offline terrain in 3D, built from the ERIS terrain package kept
/// on this iPhone (USGS 3DEP elevation, hillshade, aerial imagery when
/// packaged, roads): no network. Elevation is at true scale; vertical
/// exaggeration only stretches the display. Ported in spirit from the Expo
/// app's ErisTerrainSceneViewController (SceneKit, no ArcGIS).
@MainActor
final class SiteTerrainScene: ObservableObject {
    enum Surface: String, CaseIterable, Identifiable {
        case relief = "Relief", imagery = "Imagery"
        var id: String { rawValue }
    }

    let scene = SCNScene()
    /// The orbit camera; it exists before the terrain loads so the view starts from it.
    let camera = SCNNode()
    @Published private(set) var problem: String?
    @Published private(set) var loaded = false
    @Published private(set) var hasImagery = false
    @Published private(set) var source = ""
    /// What was drawn, in words: the grid and the ground's range.
    @Published private(set) var summary = ""
    @Published var exaggeration = TerrainScale.vertExagDefault { didSet { applyExaggeration() } }
    @Published var surface = Surface.relief { didSet { applySurface() } }

    private let worldSize = 10.0
    private let exaggerated = SCNNode()
    private var terrainMaterial = SCNMaterial()
    private var hillshade: UIImage?
    private var imagery: UIImage?
    private var meta: TerrainBundle.TerrainMeta?
    private var grid: [Float] = []
    private var scale: TerrainScale.SceneScale?

    func load(folder: URL, latitude: Double?, longitude: Double?, areas: [SiteAreas.Area]) {
        do {
            let manifestData = try Data(contentsOf: folder.appendingPathComponent("manifest.json"))
            let manifest = TerrainBundle.Manifest(json: try JSONDecoder().decode(JSONValue.self, from: manifestData))
            guard let terrain = manifest.terrain else { throw TerrainBundle.BundleError("The terrain package has no terrain.") }
            let gridName = terrain.file.isEmpty ? "elevation-grid.bin" : terrain.file
            let gridBytes = [UInt8](try Data(contentsOf: folder.appendingPathComponent(gridName)))
            grid = try TerrainBundle.decodeHeightGrid(gridBytes, rows: terrain.rows, cols: terrain.columns)
            guard let scale = TerrainScale.sceneScale(TerrainScale.Grid(terrain), worldSize: worldSize) else {
                throw TerrainBundle.BundleError("The terrain's extent is not usable.")
            }
            meta = terrain
            self.scale = scale
            hillshade = Self.rgba(UIImage(contentsOfFile: folder.appendingPathComponent("hillshade.png").path))
            imagery = Self.rgba(Self.imagery(manifest, folder: folder, bounds: terrain.bounds))
            hasImagery = imagery != nil
            surface = hasImagery ? .imagery : .relief
            let elevation = [manifest.elevation?.dataset, manifest.elevation?.resolution, manifest.elevation?.version]
                .compactMap { $0 }.filter { !$0.isEmpty }
            source = elevation.isEmpty ? "USGS 3DEP elevation" : elevation.joined(separator: " · ")
            summary = "\(terrain.columns) × \(terrain.rows) elevation grid · "
                + "\(Int(terrain.minElevationM.rounded()))–\(Int(terrain.maxElevationM.rounded())) m"
            build(latitude: latitude, longitude: longitude, areas: areas, roads: Self.roads(manifest, folder: folder))
            loaded = true
        } catch let error as TerrainBundle.BundleError {
            problem = error.message
        } catch {
            problem = "The site's terrain could not be read on this iPhone."
        }
    }

    // MARK: Building

    private func build(latitude: Double?, longitude: Double?, areas: [SiteAreas.Area], roads: [[TerrainOverlays.LonLat]]) {
        guard let meta, let scale else { return }
        scene.background.contents = UIColor.systemGray6
        scene.rootNode.addChildNode(exaggerated)
        exaggerated.addChildNode(terrainNode(meta, scale))
        applySurface()

        for road in roads where road.count >= 2 {
            exaggerated.addChildNode(lineNode(road, lift: TerrainScale.DrapeLayer.road.liftMeters, color: .systemYellow))
        }
        for area in areas {
            for ring in area {
                let coords = ring.map { TerrainOverlays.LonLat($0[0], $0[1]) }
                exaggerated.addChildNode(lineNode(coords, lift: TerrainScale.DrapeLayer.submitted.liftMeters, color: .systemRed))
            }
        }
        if let latitude, let longitude, TerrainOverlays.isLonLatInBounds(meta, lon: longitude, lat: latitude) {
            exaggerated.addChildNode(siteMarker(lon: longitude, lat: latitude))
        }

        let ambient = SCNNode()
        ambient.light = SCNLight()
        ambient.light?.type = .ambient
        ambient.light?.intensity = 450
        scene.rootNode.addChildNode(ambient)
        let sun = SCNNode()
        sun.light = SCNLight()
        sun.light?.type = .directional
        sun.light?.intensity = 900
        sun.eulerAngles = SCNVector3(-Float.pi / 3, Float.pi / 4, 0)
        scene.rootNode.addChildNode(sun)

        camera.camera = SCNCamera()
        camera.camera?.zNear = 0.01
        camera.camera?.zFar = 500
        let reach = Float(max(scale.halfWidthUnits, scale.halfDepthUnits))
        // From the south-facing side, high enough to see over the ground at 3×.
        let relief = Float((meta.maxElevationM - meta.minElevationM) * scale.sceneUnitsPerMeter)
        let target = SCNVector3(0, relief / 2, 0)
        let distance = max(reach * 2.6, relief * 3.2)
        camera.position = SCNVector3(0, target.y + distance * 0.6, distance * 0.8)
        camera.look(at: target)
        scene.rootNode.addChildNode(camera)
    }

    /// The height grid as a mesh: x east, z south, y up, at true scale.
    private func terrainNode(_ meta: TerrainBundle.TerrainMeta, _ scale: TerrainScale.SceneScale) -> SCNNode {
        let rows = meta.rows, cols = meta.columns
        var vertices: [SCNVector3] = []
        var uvs: [CGPoint] = []
        vertices.reserveCapacity(rows * cols)
        uvs.reserveCapacity(rows * cols)
        for r in 0..<rows {
            for c in 0..<cols {
                let x = (Double(c) / Double(cols - 1) - 0.5) * 2 * scale.halfWidthUnits
                let z = (Double(r) / Double(rows - 1) - 0.5) * 2 * scale.halfDepthUnits
                vertices.append(SCNVector3(Float(x), Float(height(at: Double(c), Double(r))), Float(z)))
                uvs.append(CGPoint(x: Double(c) / Double(cols - 1), y: Double(r) / Double(rows - 1)))
            }
        }
        var indices: [Int32] = []
        indices.reserveCapacity((rows - 1) * (cols - 1) * 6)
        for r in 0..<(rows - 1) {
            for c in 0..<(cols - 1) {
                let tl = Int32(r * cols + c), tr = tl + 1, bl = Int32((r + 1) * cols + c), br = bl + 1
                indices += [tl, bl, tr, tr, bl, br]
            }
        }
        let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices), SCNGeometrySource(textureCoordinates: uvs)],
                                   elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
        terrainMaterial.diffuse.wrapS = .clamp
        terrainMaterial.diffuse.wrapT = .clamp
        terrainMaterial.isDoubleSided = true
        geometry.firstMaterial = terrainMaterial
        return SCNNode(geometry: geometry)
    }

    /// Height in scene units at a grid position, between cells; no-data reads as the lowest.
    private func height(at col: Double, _ row: Double) -> Double {
        guard let meta, let scale else { return 0 }
        let c = min(max(col, 0), Double(meta.columns - 1)), r = min(max(row, 0), Double(meta.rows - 1))
        let c0 = Int(c), r0 = Int(r), c1 = min(c0 + 1, meta.columns - 1), r1 = min(r0 + 1, meta.rows - 1)
        func e(_ cc: Int, _ rr: Int) -> Double {
            let value = Double(grid[rr * meta.columns + cc])
            return value.isFinite && value != meta.noDataValue ? value : meta.minElevationM
        }
        let fc = c - Double(c0), fr = r - Double(r0)
        let top = e(c0, r0) * (1 - fc) + e(c1, r0) * fc
        let bottom = e(c0, r1) * (1 - fc) + e(c1, r1) * fc
        return ((top * (1 - fr) + bottom * fr) - meta.minElevationM) * scale.sceneUnitsPerMeter
    }

    private func point(lon: Double, lat: Double, liftMeters: Double) -> SCNVector3? {
        guard let meta, let scale else { return nil }
        let cell = TerrainOverlays.lonLatToColRow(meta, lon: lon, lat: lat)
        let x = (cell.col / Double(meta.columns - 1) - 0.5) * 2 * scale.halfWidthUnits
        let z = (cell.row / Double(meta.rows - 1) - 0.5) * 2 * scale.halfDepthUnits
        return SCNVector3(Float(x), Float(height(at: cell.col, cell.row) + liftMeters * scale.sceneUnitsPerMeter), Float(z))
    }

    /// A line on the ground, sampled finely so it follows the terrain.
    private func lineNode(_ coords: [TerrainOverlays.LonLat], lift: Double, color: UIColor) -> SCNNode {
        guard let meta else { return SCNNode() }
        let clipped = TerrainOverlays.clipToBounds(meta, coords)
        var points: [SCNVector3] = []
        for (a, b) in zip(clipped, clipped.dropFirst()) {
            for step in 0..<8 {
                let t = Double(step) / 8
                if let p = point(lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, liftMeters: lift) { points.append(p) }
            }
        }
        if let last = clipped.last, let p = point(lon: last.lon, lat: last.lat, liftMeters: lift) { points.append(p) }
        guard points.count >= 2 else { return SCNNode() }
        var indices: [Int32] = []
        for i in 0..<(points.count - 1) { indices += [Int32(i), Int32(i + 1)] }
        let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: points)],
                                   elements: [SCNGeometryElement(indices: indices, primitiveType: .line)])
        let material = SCNMaterial()
        material.diffuse.contents = color
        material.lightingModel = .constant
        geometry.firstMaterial = material
        return SCNNode(geometry: geometry)
    }

    /// The site: a red pin standing on the ground.
    private func siteMarker(lon: Double, lat: Double) -> SCNNode {
        guard let scale, let base = point(lon: lon, lat: lat, liftMeters: 0) else { return SCNNode() }
        let height = CGFloat(9 * scale.sceneUnitsPerMeter)
        let radius = CGFloat(TerrainScale.incidentRingDiameterM / 2 * scale.sceneUnitsPerMeter)
        let pin = SCNNode()
        let stem = SCNNode(geometry: SCNCylinder(radius: radius * 0.12, height: height))
        stem.position = SCNVector3(0, Float(height / 2), 0)
        let head = SCNNode(geometry: SCNSphere(radius: radius * 0.5))
        head.position = SCNVector3(0, Float(height), 0)
        for node in [stem, head] {
            node.geometry?.firstMaterial?.diffuse.contents = UIColor.systemRed
            node.geometry?.firstMaterial?.lightingModel = .constant
            pin.addChildNode(node)
        }
        pin.position = base
        pin.name = "site"
        return pin
    }

    // MARK: Display

    private func applyExaggeration() {
        let value = TerrainScale.snapExaggeration(exaggeration)
        exaggerated.scale = SCNVector3(1, Float(value), 1)
        // The pin stays upright and round while the ground stretches.
        exaggerated.childNode(withName: "site", recursively: false)?.scale = SCNVector3(1, Float(1 / value), 1)
    }

    private func applySurface() {
        if surface == .imagery, let imagery {
            terrainMaterial.diffuse.contents = imagery
            terrainMaterial.lightingModel = .constant
        } else {
            terrainMaterial.diffuse.contents = hillshade ?? UIColor(red: 0.45, green: 0.42, blue: 0.36, alpha: 1)
            terrainMaterial.lightingModel = hillshade == nil ? .lambert : .constant
        }
    }

    // MARK: Package contents

    /// The picture redrawn as 8-bit RGBA: a grey PNG becomes a one-channel
    /// texture that Metal refuses on some GPUs (the simulator's among them).
    private static func rgba(_ image: UIImage?) -> UIImage? {
        guard let image, image.size.width > 0, image.size.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }

    /// The packaged aerial imagery as one picture of the terrain's extent: a
    /// single image, or tiles placed by their bounds. Nil unless all of it loads.
    private static func imagery(_ manifest: TerrainBundle.Manifest, folder: URL, bounds: TerrainBundle.Bounds) -> UIImage? {
        guard TerrainBundle.contextLayerAvailable(manifest, .imagery) else { return nil }
        if TerrainBundle.imageryMode(manifest) != .tiled {
            let file = manifest.contextLayers?["imagery"]?.file ?? "imagery.png"
            return UIImage(contentsOfFile: folder.appendingPathComponent(file).path)
        }
        let tiles = TerrainBundle.imageryTiles(manifest)
        var loaded: [(UIImage, TerrainBundle.Bounds)] = []
        for tile in tiles {
            guard let file = tile.file, let tileBounds = tile.bounds,
                  let image = UIImage(contentsOfFile: folder.appendingPathComponent(file).path) else { return nil }
            loaded.append((image, tileBounds))
        }
        guard !loaded.isEmpty else { return nil }
        let lonSpan = bounds.maxLon - bounds.minLon, latSpan = bounds.maxLat - bounds.minLat
        guard lonSpan > 0, latSpan > 0 else { return nil }
        // Pixel size from the tiles' own resolution, kept within 4096 on the long side.
        let first = loaded[0]
        let pxPerLon = first.0.size.width / CGFloat(first.1.maxLon - first.1.minLon)
        let pxPerLat = first.0.size.height / CGFloat(first.1.maxLat - first.1.minLat)
        var size = CGSize(width: CGFloat(lonSpan) * pxPerLon, height: CGFloat(latSpan) * pxPerLat)
        let shrink = min(1, 4096 / max(size.width, size.height))
        size = CGSize(width: size.width * shrink, height: size.height * shrink)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            for (image, tile) in loaded {
                let x = CGFloat((tile.minLon - bounds.minLon) / lonSpan) * size.width
                let y = CGFloat((bounds.maxLat - tile.maxLat) / latSpan) * size.height
                let w = CGFloat((tile.maxLon - tile.minLon) / lonSpan) * size.width
                let h = CGFloat((tile.maxLat - tile.minLat) / latSpan) * size.height
                image.draw(in: CGRect(x: x, y: y, width: w, height: h))
            }
        }
    }

    /// The packaged road centerlines.
    private static func roads(_ manifest: TerrainBundle.Manifest, folder: URL) -> [[TerrainOverlays.LonLat]] {
        guard TerrainBundle.contextLayerAvailable(manifest, .roads), let file = manifest.contextLayers?["roads"]?.file,
              let data = try? Data(contentsOf: folder.appendingPathComponent(file)),
              let json = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let collection) = json, case .array(let features)? = collection["features"] else { return [] }
        return features.flatMap { feature -> [[TerrainOverlays.LonLat]] in
            guard case .object(let f) = feature else { return [] }
            return TerrainOverlays.normalizeOverlayGeometry(f["geometry"]).filter { $0.kind == .line }.map(\.coords)
        }
    }
}

/// The 3D terrain screen: orbit with a finger, pinch to zoom, stretch the
/// relief, switch between imagery and relief.
struct SiteTerrainView: View {
    @Environment(\.dismiss) private var dismiss
    let folder: URL
    let latitude: Double?
    let longitude: Double?
    let areas: [SiteAreas.Area]
    @StateObject private var terrain = SiteTerrainScene()

    var body: some View {
        NavigationStack {
            Group {
                if let problem = terrain.problem {
                    ContentUnavailableView("Terrain unavailable", systemImage: "mountain.2", description: Text(problem))
                } else {
                    SceneView(scene: terrain.scene, pointOfView: terrain.camera,
                              options: [.allowsCameraControl, .autoenablesDefaultLighting])
                        .accessibilityIdentifier("site-terrain")
                        .ignoresSafeArea(edges: .bottom)
                        .overlay(alignment: .bottom) { controls.padding() }
                }
            }
            .navigationTitle("Site in 3D")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { if !terrain.loaded { terrain.load(folder: folder, latitude: latitude, longitude: longitude, areas: areas) } }
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            if terrain.hasImagery {
                Picker("Surface", selection: $terrain.surface) {
                    ForEach(SiteTerrainScene.Surface.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            HStack {
                Text("Vertical \(TerrainScale.exaggerationLabel(terrain.exaggeration))").font(.caption.monospacedDigit())
                    .accessibilityIdentifier("site-terrain-exaggeration")
                Slider(value: $terrain.exaggeration, in: TerrainScale.vertExagMin...TerrainScale.vertExagMax,
                       step: TerrainScale.vertExagStep)
                    .accessibilityLabel("Vertical exaggeration")
            }
            Text(terrain.summary).font(.caption2).accessibilityIdentifier("site-terrain-status")
            Text(terrain.source).font(.caption2).foregroundStyle(.secondary)
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

/// In Measurements: the site in 3D when its terrain is on this iPhone, or a way to get it.
struct SiteTerrainSection: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var offline: OfflineSync
    @Environment(\.gisaPhotos) private var photos
    let latitude: Double?
    let longitude: Double?
    let geometry: String
    @State private var showing = false
    @State private var asking = false
    @State private var note: String?

    var body: some View {
        if let id = photos.detail?.submission.id {
            let folder = offline.store.terrainFolder(id)
            VStack(alignment: .leading, spacing: 4) {
                if let folder {
                    Button("View the Site in 3D") { showing = true }
                        .accessibilityIdentifier("site-terrain-open")
                        .fullScreenCover(isPresented: $showing) {
                            SiteTerrainView(folder: folder, latitude: latitude, longitude: longitude,
                                            areas: SiteAreas.areas(fromText: geometry))
                        }
                    Text("Elevation, imagery and roads kept on this iPhone; works offline.").font(.caption).foregroundStyle(.secondary)
                } else {
                    Button(asking ? "Getting the Site's Terrain…" : "Get the Site's 3D Terrain") { Task { await get(id) } }
                        .disabled(asking)
                        .accessibilityIdentifier("site-terrain-get")
                    Text(note ?? "It also arrives on its own with work assigned to you.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func get(_ id: Int) async {
        asking = true
        defer { asking = false }
        switch await AssignedTerrain(api: model.api, store: offline.store).keep(id) {
        case .downloaded, .kept: note = nil
        case .preparing: note = "ERIS is preparing it; it arrives on its own when ready."
        case .unavailable(let why): note = why
        case .unreachable: note = "ERIS can't be reached. It arrives on its own once connected."
        }
    }
}
