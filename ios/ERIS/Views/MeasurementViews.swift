import Charts
import ERISKit
import SwiftUI

/// Measurements: the road inventory segment, the ground across the road, the
/// cross-section diagram and the eight GISA-001 measurements. The 3D terrain
/// comes later, with the ArcGIS Maps SDK.
struct GisaMeasurementsSection: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.gisaPhotos) private var photos
    @Binding var editor: GisaEditor
    let canEdit: Bool
    @State private var profile: ElevationProfile?
    @State private var loadedFrom: Int?
    @State private var bearing = ""
    @State private var refreshing = false
    @State private var problem: String?

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    var body: some View {
        let gisa = photos.detail?.gisa
        Section {
            if let context = RoadInventoryContext(gisa: gisa) {
                Label("Road inventory context active", systemImage: "road.lanes").foregroundStyle(.green)
                ForEach(context.rows, id: \.label) { row in LabeledContent(row.label, value: row.value) }
            } else {
                Text("No road inventory context attached. Diagram uses form / default roadway assumptions.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        } header: {
            Text("Measurements")
        }

        Section {
            if let profile {
                if let classification = profile.classification { LabeledContent("Terrain summary", value: classification) }
                if let confidence = profile.confidenceText { LabeledContent("Confidence", value: confidence) }
                LabeledContent("Road orientation", value: profile.orientationNote)
                if let reason = profile.reasonNote { LabeledContent("Why unknown", value: reason) }
                if let source = profile.source { LabeledContent("Source", value: source) }
                if let checked = profile.checkedAt { LabeledContent("Checked", value: String(checked.prefix(10))) }
                if profile.chartPoints.count >= 2 { ElevationChart(points: profile.chartPoints) }
            } else {
                Text("No elevation profile fetched.").foregroundStyle(.secondary)
            }
            if canEdit, let id = photos.detail?.submission.id {
                DisclosureGroup("Set road orientation manually") {
                    LabeledTextField(label: "Bearing (°)", text: $bearing, keyboard: .decimalPad)
                    Text("Compass heading up-station. Leave blank to auto-detect, then Refresh.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button(refreshing ? "Refreshing…" : profile == nil ? "Fetch Elevation Profile" : "Refresh Elevation Profile") {
                    Task { await refresh(id) }
                }
                .disabled(refreshing)
            }
            if let problem { Text(problem).foregroundStyle(.red) }
        } header: {
            Text("Elevation profile")
        } footer: {
            Text("Ground elevation across the road at this location, from USGS.")
        }

        MeasurementDiagramSection(form: editor.form, snapshot: RoadInventoryContext(gisa: gisa)?.snapshot, profile: profile)

        Section {
            ForEach(GisaEditor.measurementFields, id: \.0) { key, label in
                GisaTextField(label: label, value: binding(key), editable: canEdit, keyboard: .decimalPad,
                              error: editor.errors[key])
            }
            GisaSectionPhotos(sectionKey: "measurements")
        } footer: {
            Text("The 3D terrain is not on iPhone yet.")
        }
        .onAppear(perform: loadProfile)
        .onChange(of: photos.detail?.submission.id) { loadProfile() }
    }

    /// The saved profile, once per form; a refresh replaces it on screen.
    private func loadProfile() {
        guard let id = photos.detail?.submission.id, loadedFrom != id else { return }
        loadedFrom = id
        profile = ElevationProfile(gisa: photos.detail?.gisa)
    }

    private func refresh(_ id: Int) async {
        switch ElevationProfile.bearing(bearing) {
        case .failure(let failure):
            problem = failure.message
        case .success(let typed):
            refreshing = true
            defer { refreshing = false }
            do {
                profile = try await SubmissionsAPI(api: model.api).refreshElevationProfile(id, roadBearing: typed)
                problem = nil
            } catch {
                problem = model.handle(error)
            }
        }
    }
}

/// Elevation across the road: offset from the centreline against height.
struct ElevationChart: View {
    let points: [ElevationProfile.Point]

    var body: some View {
        Chart(points, id: \.offsetM) { point in
            LineMark(x: .value("Offset (m)", point.offsetM), y: .value("Elevation (ft)", point.elevationFt ?? 0))
                .interpolationMethod(.monotone)
            AreaMark(x: .value("Offset (m)", point.offsetM), y: .value("Elevation (ft)", point.elevationFt ?? 0))
                .foregroundStyle(.linearGradient(colors: [.brown.opacity(0.35), .brown.opacity(0.05)], startPoint: .top, endPoint: .bottom))
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .chartXAxisLabel("Offset from centreline (m)")
        .chartYAxisLabel("ft")
        .frame(height: 160)
        .accessibilityLabel("Elevation across the road")
    }
}
