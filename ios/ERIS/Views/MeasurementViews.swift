import Charts
import ERISKit
import SwiftUI

/// What was measured on this form, kept above the steps so it survives moving between them.
@MainActor
final class SiteMeasuringModel: ObservableObject {
    @Published private(set) var surveys: [DroneSurvey] = []
    @Published var nowId: Int? { didSet { if nowId != oldValue { applyCompareWith() } } }
    /// Nil: the terrain model is the ground before.
    @Published var beforeId: Int?
    @Published var areaIndex = 0
    @Published private(set) var busy: String?
    @Published private(set) var problem: String?
    @Published private(set) var result: SiteMeasureResult?
    @Published private(set) var resultKey = ""
    private var loadedFor: Int?

    func key(area: SiteAreas.Area?) -> String {
        "\(area ?? [])|\(nowId ?? 0)|\(beforeId ?? 0)"
    }

    /// The measurement, while it still describes the area and surveys chosen.
    func current(area: SiteAreas.Area?) -> SiteMeasureResult? {
        resultKey == key(area: area) ? result : nil
    }

    func loadSurveys(_ submissionId: Int, api: APIClient, store: OfflineStore) async {
        guard loadedFor != submissionId else { return }
        loadedFor = submissionId
        surveys = (try? await DroneSurveysAPI(api: api, store: store).list(submissionId)) ?? []
        nowId = surveys.first?.id
    }

    private func applyCompareWith() {
        let other = surveys.first { $0.id == nowId }?.compareWithSurveyId
        beforeId = surveys.contains { $0.id == other && $0.id != nowId } ? other : nil
    }

    func measure(_ submissionId: Int, area: SiteAreas.Area, api: APIClient, store: OfflineStore, terrainFolder: URL?) async {
        problem = nil
        do {
            let surveysAPI = DroneSurveysAPI(api: api, store: store)
            var now: SurveyGround?
            var before: SurveyGround?
            if let survey = surveys.first(where: { $0.id == nowId }) {
                busy = "Getting the drone survey…"
                now = SurveyGround(survey: survey, grid: try await surveysAPI.grid(submissionId, survey: survey.id))
                if let earlier = surveys.first(where: { $0.id == beforeId }) {
                    before = SurveyGround(survey: earlier, grid: try await surveysAPI.grid(submissionId, survey: earlier.id))
                }
            }
            busy = "Measuring the ground…"
            let key = key(area: area)
            result = try await Self.measured(area: area, now: now, before: before, api: api, store: store, terrainFolder: terrainFolder)
            resultKey = key
        } catch let refused as SiteMeasureResult.Problem {
            problem = refused.message
        } catch is DroneGrid.Damaged {
            problem = "The drone survey could not be read."
        } catch {
            problem = "No connection, and this survey or the site's terrain is not on this iPhone yet. You can still type the values in."
        }
        busy = nil
    }

    /// The USGS tiles the website reads, kept once read. Without a signal or a copy of them,
    /// the terrain package kept on this iPhone, which the screen then says.
    private static func measured(area: SiteAreas.Area, now: SurveyGround?, before: SurveyGround?, api: APIClient, store: OfflineStore, terrainFolder: URL?) async throws -> SiteMeasureResult {
        #if DEBUG
        if DemoServer.isEnabled {
            return try await SiteMeasureResult.measure(area: area, terrain: DemoElevation(), now: now, before: before)
        }
        #endif
        do {
            return try await SiteMeasureResult.measure(area: area, terrain: KeptElevationTiles(api: api, store: store).elevation, now: now, before: before)
        } catch let refused as SiteMeasureResult.Problem {
            throw refused
        } catch {
            guard let folder = terrainFolder, let kept = PackagedElevation(folder: folder) else { throw error }
            return try await SiteMeasureResult.measure(area: area, terrain: kept, now: now, before: before)
        }
    }

    /// Keeps the elevation around the site and under the areas while there is a signal,
    /// so they can be measured later without one.
    func keepTiles(form: GisaForm, api: APIClient, store: OfflineStore) async {
        guard !DemoMode.isOn else { return }
        await KeptElevationTiles(api: api, store: store).keep(form: form)
    }
}

/// Measurements: the sketch and the eight values people collect, then what the
/// terrain and any drone survey suggest, the profile, and the site in 3D.
struct GisaMeasurementsSection: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var offline: OfflineSync
    @EnvironmentObject private var measuring: SiteMeasuringModel
    @Environment(\.gisaPhotos) private var photos
    @Binding var editor: GisaEditor
    let canEdit: Bool
    /// The location map, for drawing the outline.
    var goToMap: () -> Void = {}
    @State private var showingSketch = false
    @FocusState private var focused: String?

    private var areas: [SiteAreas.Area] { SiteAreas.areas(fromText: editor.form["geometry_json"]) }
    private var area: SiteAreas.Area? { areas.indices.contains(measuring.areaIndex) ? areas[measuring.areaIndex] : areas.first }
    private var current: SiteMeasureResult? { measuring.current(area: area) }
    private var submissionId: Int? { photos.detail?.submission.id }

    var body: some View {
        Section {
            Label("This data has not been reviewed by land surveyors. Take it as a suggestion, not as fact.", systemImage: "exclamationmark.triangle")
                .font(.callout).foregroundStyle(.orange)
                .accessibilityIdentifier("measurements-not-surveyed")
            Button { showingSketch = true } label: {
                Image("LandslideSketch").resizable().scaledToFit().frame(maxHeight: 260).frame(maxWidth: .infinity)
                    .padding(6).background(.white, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open the landslide sketch")
            .accessibilityIdentifier("measurement-sketch")
            .fullScreenCover(isPresented: $showingSketch) { LandslideSketchView() }
        } header: {
            Text("Measurements")
        }

        ForEach(GisaEditor.measurementGroups) { group in
            Section(group.title) {
                ForEach(group.fields) { field in
                    MeasurementFieldRow(field: field, value: binding(field.key), editable: canEdit,
                                        error: editor.errors[field.key], suggestion: suggestion(for: field),
                                        hasSurvey: !measuring.surveys.isEmpty, focused: $focused)
                }
            }
        }

        Section { GisaSectionPhotos(sectionKey: "measurements") }

        measuringSection
        if let current { MeasuredSections(result: current) }

        Section {
            SiteTerrainSection(latitude: Double(editor.form["latitude"]), longitude: Double(editor.form["longitude"]),
                               geometry: editor.form["geometry_json"])
        } header: {
            Text("Terrain")
        }
        .task(id: submissionId) {
            guard let submissionId else { return }
            await measuring.loadSurveys(submissionId, api: model.api, store: offline.store)
            await measuring.keepTiles(form: editor.form, api: model.api, store: offline.store)
        }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    private func suggestion(for field: MeasurementField) -> MeasurementFieldRow.Suggestion? {
        guard let current else { return nil }
        switch field.source {
        case .scarp:
            return current.scarp.map { .init(value: $0.feetText, from: "Drone survey", review: true) }
        case .ground:
            return current.suggestions[field.key].map { .init(value: $0, from: current.from(field.key), review: false) }
        case .site:
            return nil
        }
    }

    /// The values to fill together. The scarp is never one of them: it is reviewed and used on purpose.
    private var empty: [String] { (current?.suggestions.keys).map { $0.filter { editor.form[$0].isEmpty } } ?? [] }
    private var different: [String] {
        guard let current else { return [] }
        return current.suggestions.filter { Double(editor.form[$0.key]) != Double($0.value) }.map(\.key)
    }

    @ViewBuilder private var measuringSection: some View {
        Section {
            if areas.isEmpty {
                Text("Draw the slide's outline on the location map to measure it from the terrain.")
                Button("Go to the Map", action: goToMap)
            } else {
                if areas.count > 1 {
                    Picker("Area", selection: $measuring.areaIndex) {
                        ForEach(areas.indices, id: \.self) { Text("Area \($0 + 1)").tag($0) }
                    }
                }
                if !measuring.surveys.isEmpty {
                    Picker("Now", selection: $measuring.nowId) {
                        ForEach(measuring.surveys) { Text($0.title).tag(Optional($0.id)) }
                    }
                    .accessibilityIdentifier("measure-now")
                    Picker("Before", selection: $measuring.beforeId) {
                        Text("Terrain model").tag(Int?.none)
                        ForEach(measuring.surveys.filter { $0.id != measuring.nowId }) { Text($0.title).tag(Optional($0.id)) }
                    }
                    .accessibilityIdentifier("measure-before")
                }
                if let submissionId, let area {
                    Button {
                        Task {
                            await measuring.measure(submissionId, area: area, api: model.api, store: offline.store,
                                                    terrainFolder: offline.store.terrainFolder(submissionId))
                        }
                    } label: {
                        Label(current == nil ? "Measure" : "Measure Again", systemImage: "mountain.2").bold()
                    }
                    .disabled(measuring.busy != nil)
                    .accessibilityIdentifier("measure-site")
                }
                if let busy = measuring.busy {
                    HStack { ProgressView(); Text(busy).foregroundStyle(.secondary) }
                }
                if let problem = measuring.problem { Text(problem).foregroundStyle(.red) }
                if measuring.result != nil, current == nil, measuring.busy == nil {
                    Text("The area or the survey changed since it was measured. Measure it again.").foregroundStyle(.orange)
                }
                if let current, current.terrainSource == PackagedElevation.name {
                    Text("Measured with no signal from the terrain kept on this iPhone, which is coarser than the website's elevation data, so values can differ. Measure again with a signal to match the website.")
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("measured-offline-differs")
                }
                if let coverage = current?.droneCoverage, current?.drone == nil {
                    Text("The drone survey covers \(Int((coverage * 100).rounded()))% of this area, too little to measure the ground now. These values come from the terrain model only.")
                        .foregroundStyle(.orange)
                }
                if canEdit, !different.isEmpty {
                    let keys = empty.isEmpty ? different : empty
                    Button(empty.isEmpty ? "Replace \(keys.count) with the Suggested Values" : "Use the \(keys.count) Suggested Values") {
                        for key in keys {
                            if let value = current?.suggestions[key] { editor.set(key, value) }
                        }
                    }
                    .accessibilityIdentifier("measure-use-all")
                }
            }
        } header: {
            Text("Suggestions")
        } footer: {
            if !areas.isEmpty, current?.terrainSource != PackagedElevation.name {
                Text(measuring.surveys.isEmpty
                     ? "From the terrain, usually mapped before the slide, using the same USGS elevation as the website. Works with no signal for assigned work. Drone surveys are added on the website."
                     : "From the terrain and the drone survey, using the same USGS elevation as the website.")
            }
        }
    }
}

/// One value: what it is on the sketch, the box to type it in, and any suggestion.
struct MeasurementFieldRow: View {
    struct Suggestion: Equatable {
        let value: String
        let from: String
        let review: Bool
    }

    let field: MeasurementField
    @Binding var value: String
    let editable: Bool
    let error: String?
    let suggestion: Suggestion?
    let hasSurvey: Bool
    var focused: FocusState<String?>.Binding

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Side by side while both fit: at a large text size, one above the other.
            ViewThatFits(in: .horizontal) {
                HStack {
                    title
                    Spacer(minLength: 12)
                    box.frame(width: 120)
                }
                VStack(alignment: .leading, spacing: 6) {
                    title
                    box
                }
            }
            if field.unit == .degrees {
                Slider(value: Binding(get: { GisaEditor.measurementAngle(value) ?? 0 },
                                      set: { value = GisaEditor.measurementAngleText($0) }),
                       in: 0...90, step: 0.5)
                    .disabled(!editable)
                    .accessibilityLabel(field.name)
            }
            note
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(.vertical, 2)
    }

    private var title: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            (Text(field.symbol).italic().bold() + Text(field.subscriptText).font(.caption).italic().bold().baselineOffset(-3))
                .font(.system(.body, design: .serif))
                .foregroundStyle(Color.accentColor)
                .frame(minWidth: 26, alignment: .leading)
            Text(field.name)
        }
        .accessibilityElement(children: .combine)
    }

    private var box: some View {
        HStack(spacing: 4) {
            TextField(field.label, text: $value, prompt: Text(""))
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
                .focused(focused, equals: field.key)
                .disabled(!editable)
                .foregroundStyle(editable ? .primary : .secondary)
                .accessibilityLabel(field.label)
                .accessibilityIdentifier(field.key)
                .toolbar {
                    if focused.wrappedValue == field.key, let next = GisaEditor.measurementField(after: field.key) {
                        ToolbarItem(placement: .keyboard) {
                            Button("Next") { focused.wrappedValue = next }
                        }
                    }
                }
            Text(field.unit.rawValue).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 44)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder private var note: some View {
        if let suggestion {
            VStack(alignment: .leading, spacing: 3) {
                let units = field.unit == .degrees ? "°" : " ft"
                if Double(value) == Double(suggestion.value) {
                    Label("Suggested value in use", systemImage: "checkmark").font(.caption).foregroundStyle(.green)
                } else if editable {
                    Button("Use \(suggestion.value)\(units)") { value = suggestion.value }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("use-\(field.key)")
                } else {
                    Text("Suggested: \(suggestion.value)\(units)").font(.caption).foregroundStyle(.secondary)
                }
                if suggestion.review {
                    Text("Drone survey suggestion. Please review it on site.")
                        .font(.caption.weight(.semibold)).foregroundStyle(.orange)
                } else {
                    Text(suggestion.from).font(.caption).foregroundStyle(.secondary)
                }
            }
        } else if field.source != .ground {
            Text(field.source == .scarp && hasSurvey ? "Measure on site, or measure the drone survey for a suggestion" : "Measure on site")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// What a measurement found, and the ground along the slope.
struct MeasuredSections: View {
    let result: SiteMeasureResult

    private func feet(_ metres: Double) -> String {
        "\(Int((metres * SiteTerrain.feetPerMetre).rounded()).formatted()) ft"
    }
    private func change(_ metres: Double) -> String { String(format: "%.1f ft", metres * SiteTerrain.feetPerMetre) }
    private func yards(_ cubicMetres: Double) -> String { "\(Int((cubicMetres * 1.307950619).rounded()).formatted()) yd³" }
    private func angle(_ degrees: Double) -> String { String(format: "%.1f°", degrees) }

    var body: some View {
        if let drone = result.drone {
            let c = drone.comparison
            Section("What Changed") {
                LabeledContent("Deepest drop", value: change(c.maxLossM))
                LabeledContent("Highest rise", value: change(c.maxGainM))
                LabeledContent("Ground lost", value: yards(c.lossVolumeM3))
                LabeledContent("Ground gained", value: yards(c.gainVolumeM3))
                LabeledContent("Net change", value: "\(c.netVolumeM3 >= 0 ? "+" : "−")\(yards(abs(c.netVolumeM3)))")
                if drone.seaShare > 0 {
                    Text("\(Int((drone.seaShare * 100).rounded()))% of the compared area was sea before, so the true volume gained there is larger.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section {
                row("Slope", angle(c.original.landslideSlopeDeg), angle(c.updated.landslideSlopeDeg))
                row("Height", feet(c.original.slopeHeightM), feet(c.updated.slopeHeightM))
                row("Low point", feet(c.original.lowElevationM), feet(c.updated.lowElevationM))
                row("High point", feet(c.original.highElevationM), feet(c.updated.highElevationM))
                row("Length", feet(c.original.slopeLengthM), feet(c.updated.slopeLengthM))
            } header: {
                Text("Before and Now")
            } footer: {
                Text("Before: \(drone.beforeTitle). Now: \(drone.nowTitle).")
            }
        } else {
            let m = result.measurement
            Section {
                LabeledContent("Faces", value: SiteTerrain.bearingLabel(m.downslopeBearingDeg))
                LabeledContent("Elevation", value: "\(feet(m.lowElevationM)) – \(feet(m.highElevationM))")
                LabeledContent("Plan length", value: feet(m.horizontalLengthM))
                LabeledContent("Source", value: result.terrainSource)
            } header: {
                Text("The Ground as Mapped")
            } footer: {
                Text("Displacement and volumes need a drone survey to compare with this ground.")
            }
        }
        Section {
            ProfileCharts(section: result.section, title: result.drone?.beforeTitle)
        } header: {
            Text(result.drone == nil ? "Profile" : "Profile and Displacement")
        }
    }

    private func row(_ label: String, _ before: String, _ now: String) -> some View {
        LabeledContent(label) {
            Text("\(before) → \(Text(now).bold())").monospacedDigit()
        }
    }
}

/// The ground down the slope, and under it how far it moved at each spot on the same distances.
struct ProfileCharts: View {
    let section: [SiteTerrain.SectionSpot]
    let title: String?
    @State private var picked: Double?
    private static let lost = Color(red: 0.76, green: 0.34, blue: 0.05)
    private static let gained = Color(red: 0.08, green: 0.47, blue: 0.65)

    private struct Spot: Identifiable {
        let id: Int
        let distanceFt: Double
        let beforeFt: Double?
        let nowFt: Double?
        var changeFt: Double? {
            guard let beforeFt, let nowFt else { return nil }
            return nowFt - beforeFt
        }
    }

    private var spots: [Spot] {
        let k = SiteTerrain.feetPerMetre
        return section.enumerated().map { i, s in
            Spot(id: i, distanceFt: s.distanceM * k, beforeFt: s.before.map { $0 * k }, nowFt: s.now.map { $0 * k })
        }
    }
    private var hasNow: Bool { spots.contains { $0.nowFt != nil } }
    private var length: Double { max(1, spots.last?.distanceFt ?? 1) }
    private var showDisplacement: Bool { spots.filter { $0.changeFt != nil }.count >= 2 }
    private var pickedSpot: Spot? {
        guard let picked else { return nil }
        return spots.min { abs($0.distanceFt - picked) < abs($1.distanceFt - picked) }
    }
    private var readout: String {
        guard let spot = pickedSpot else { return "Touch the graph to read the ground there." }
        func ft(_ value: Double?) -> String { value.map { "\(Int($0.rounded()).formatted()) ft" } ?? "—" }
        var parts = ["\(Int(spot.distanceFt.rounded()).formatted()) ft along"]
        parts.append(hasNow ? "before \(ft(spot.beforeFt))" : ft(spot.beforeFt))
        if hasNow { parts.append("now \(ft(spot.nowFt))") }
        if let change = spot.changeFt { parts.append(String(format: "%@%.1f ft", change >= 0 ? "+" : "−", abs(change))) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(readout).font(.caption.monospacedDigit()).foregroundStyle(.secondary).accessibilityIdentifier("profile-readout")
            Chart {
                ForEach(spots) { spot in
                    if let before = spot.beforeFt {
                        LineMark(x: .value("Distance", spot.distanceFt), y: .value("Ground", before), series: .value("Ground", "Before"))
                            .foregroundStyle(hasNow ? Color.secondary : Color.accentColor)
                            .lineStyle(hasNow ? StrokeStyle(lineWidth: 2, dash: [6, 4]) : StrokeStyle(lineWidth: 2.5))
                    }
                    if let now = spot.nowFt {
                        LineMark(x: .value("Distance", spot.distanceFt), y: .value("Ground", now), series: .value("Ground", "Now"))
                            .foregroundStyle(Color.accentColor)
                            .lineStyle(StrokeStyle(lineWidth: 2.5))
                    }
                }
                if let spot = pickedSpot { RuleMark(x: .value("Distance", spot.distanceFt)).foregroundStyle(.yellow) }
            }
            .chartXScale(domain: 0...length)
            .chartYScale(domain: .automatic(includesZero: false))
            .chartYAxisLabel("Elevation (ft)")
            .chartXSelection(value: $picked)
            .frame(height: 200)
            .accessibilityLabel(hasNow ? "The ground before and now, down the slope" : "The ground down the slope")
            .accessibilityIdentifier("profile-chart")

            if showDisplacement {
                Text("Displacement along this line (ft)").font(.caption.weight(.semibold))
                Chart {
                    ForEach(spots) { spot in
                        if let change = spot.changeFt {
                            AreaMark(x: .value("Distance", spot.distanceFt), yStart: .value("Zero", 0), yEnd: .value("Lost", min(0, change)), series: .value("Part", "Lost"))
                                .foregroundStyle(Self.lost)
                            AreaMark(x: .value("Distance", spot.distanceFt), yStart: .value("Zero", 0), yEnd: .value("Gained", max(0, change)), series: .value("Part", "Gained"))
                                .foregroundStyle(Self.gained)
                        }
                    }
                    if let spot = pickedSpot { RuleMark(x: .value("Distance", spot.distanceFt)).foregroundStyle(.yellow) }
                }
                .chartXScale(domain: 0...length)
                .chartXAxisLabel("Distance down the slope (ft)")
                .chartXSelection(value: $picked)
                .frame(height: 120)
                .accessibilityLabel("How far the ground moved along the slope")
                .accessibilityIdentifier("displacement-chart")
                Text("Dashed: before. Solid: now. Orange: ground lost. Blue: ground gained.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

/// The reference sketch, large, to read its symbols in the field.
struct LandslideSketchView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var scale = 1.0
    @State private var settled = 1.0

    var body: some View {
        NavigationStack {
            Image("LandslideSketch").resizable().scaledToFit()
                .scaleEffect(scale)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.white)
                .gesture(MagnifyGesture()
                    .onChanged { scale = max(1, min(5, settled * $0.magnification)) }
                    .onEnded { _ in settled = scale })
                .accessibilityLabel("Landslide sketch with H, alpha, Wd, Ld, Hs, beta, Lr and Wr")
                .navigationTitle("Landslide Sketch")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
