import ERISKit
import PhotosUI
import SwiftUI

/// The GISA editor, as in mobile/app/(tabs)/submissions/[id].tsx: five steps,
/// editable while the submission is a draft or returned and the server allows
/// it. Steps are ported one at a time; a step not yet ported shows its saved
/// values, and saving keeps them unchanged.
struct SubmissionDetailView: View {
    @EnvironmentObject private var model: AppModel
    let submissionId: Int
    @State private var detail: SubmissionDetail?
    @State private var editor: GisaEditor?
    @State private var lookups = GisaLookups.empty
    @State private var step = GisaStep.header
    @State private var error: String?
    @State private var alert: GisaEditor.SaveProblem?
    @State private var saving = false
    @State private var browserURL: IdentifiableURL?
    @State private var cameraSection: PhotoTarget?
    @State private var librarySection: String?
    @State private var libraryItem: PhotosPickerItem?
    @State private var uploadingSection: String?
    @State private var openPhoto: AttachmentRef?

    /// The section a new photo will be filed under.
    struct PhotoTarget: Identifiable {
        let sectionKey: String
        var id: String { sectionKey }
    }

    var body: some View {
        Group {
            if let detail, let editor = Binding($editor) {
                content(detail, editor)
            } else if let error {
                Text(error).foregroundStyle(.red).padding()
            } else {
                ProgressView()
            }
        }
        .navigationTitle(detail?.submission.status == "DRAFT" ? "Draft" : "Submission")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $browserURL) { SafariView(url: $0.url) }
        .sheet(item: $openPhoto) { PhotoDetailView(submissionId: submissionId, attachment: $0) }
        .fullScreenCover(item: $cameraSection) { target in
            MappedCameraScreen(onCaptured: { capture in
                cameraSection = nil
                Task { await upload(capture, to: target.sectionKey) }
            }, onCancel: { cameraSection = nil })
        }
        .photosPicker(isPresented: Binding(get: { librarySection != nil }, set: { if !$0 && libraryItem == nil { librarySection = nil } }),
                      selection: $libraryItem, matching: .images)
        .onChange(of: libraryItem) { _, item in
            guard let item, let section = librarySection else { return }
            libraryItem = nil
            librarySection = nil
            Task {
                do {
                    guard let photo = try await LibraryPhoto.load(item) else {
                        alert = .init(title: "Photo unavailable", message: "That photo could not be read.")
                        return
                    }
                    await upload(photo, to: section)
                } catch {
                    alert = .init(title: "Photo unavailable", message: error.localizedDescription)
                }
            }
        }
        .alert(alert?.title ?? "", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
            Button("OK", role: .cancel) { alert = nil }
        } message: {
            Text(alert?.message ?? "")
        }
    }

    private func content(_ detail: SubmissionDetail, _ editor: Binding<GisaEditor>) -> some View {
        let canEdit = detail.submission.isEditable
        let form = editor.wrappedValue.form
        return List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text(SubmissionDescriptor.text(district: form["district"], county: form["county"], route: form["route"],
                                                   postMile: form["post_mile"], createdAt: detail.submission.createdAt))
                        .font(.subheadline)
                    Text("Status: \(SubmissionLabels.status(detail.submission.status))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Picker("Step", selection: $step) {
                    ForEach(GisaStep.allCases) { Text($0.shortTitle).tag($0) }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text("Step \(step.rawValue + 1) of \(GisaStep.allCases.count): \(step.title)")
            }

            switch step {
            case .header:
                GisaHeaderSections(editor: editor, canEdit: canEdit)
            case .body:
                GisaBodySections(editor: editor, canEdit: canEdit, lookups: lookups)
                GisaSavedValuesSection(detail: detail, step: step)
            case .gallery:
                GisaGallerySection(detail: detail, openPDF: { Task { await openPDF() } })
            default:
                GisaSavedValuesSection(detail: detail, step: step)
            }

            if let next = GisaStep(rawValue: step.rawValue + 1) {
                Section {
                    Button("Continue to \(next.title)") { withAnimation { step = next } }
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .environment(\.gisaPhotos, GisaPhotoContext(
            detail: detail, canEdit: canEdit, busySection: uploadingSection,
            add: { section, source in
                switch source {
                case .camera: cameraSection = PhotoTarget(sectionKey: section)
                case .library: librarySection = section
                }
            },
            open: { openPhoto = $0 }))
        .toolbar {
            if canEdit {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(saving)
            }
        }
    }

    private func load() async {
        let submissions = SubmissionsAPI(api: model.api)
        do {
            let loaded = try await submissions.detail(submissionId)
            // The lists are needed to check actions on save; an older cache is
            // part of the offline work, so a failure leaves them empty for now.
            if let fetched = try? await submissions.lookups() { lookups = fetched }
            detail = loaded
            editor = GisaEditor(detail: loaded)
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }

    /// Checks and sends the draft as the Expo editor's Save does, then reloads.
    private func save() async {
        guard var current = editor else { return }
        let prepared = current.prepareSave(lookups: lookups)
        editor = current
        switch prepared {
        case .failure(let problem):
            if GisaStep.header.owns(current.errors.keys) { step = .header }
            alert = problem
        case .success(let request):
            saving = true
            defer { saving = false }
            do {
                try await SubmissionsAPI(api: model.api).saveGisa(submissionId, form: request.body,
                                                                  incidentTypes: request.incidentTypes,
                                                                  actions: request.actions)
                await load()
                alert = .init(title: "Saved", message: "Draft saved.")
            } catch {
                alert = .init(title: "Save failed", message: model.handle(error))
            }
        }
    }

    /// Files a photo under its form section. Only the attachment list is
    /// refreshed afterwards, so unsaved form changes are kept.
    private func upload(_ photo: MappedPhotoCapture, to section: String) async {
        uploadingSection = section
        defer { uploadingSection = nil }
        let submissions = SubmissionsAPI(api: model.api)
        do {
            _ = try await submissions.uploadAttachment(submissionId, file: photo.jpeg, fileName: photo.fileName,
                                                       mimeType: "image/jpeg", sectionKey: section, kind: "PHOTO",
                                                       capture: photo.metadata)
            if let fresh = try? await submissions.detail(submissionId) { detail = fresh }
        } catch {
            alert = .init(title: "Photo upload failed", message: model.handle(error))
        }
    }

    private func openPDF() async {
        do {
            let link = try await SubmissionsAPI(api: model.api).gisaPDF(submissionId)
            if let url = URL(string: link.downloadUrl) { browserURL = IdentifiableURL(url: url) }
        } catch APIError.notFound {
            alert = .init(title: "No PDF yet", message: "No GISA PDF has been generated yet.")
        } catch {
            alert = .init(title: "PDF unavailable", message: model.handle(error))
        }
    }
}

/// The editor's five steps.
enum GisaStep: Int, CaseIterable, Identifiable {
    case header, body, assessment, actions, gallery

    var id: Int { rawValue }

    var title: String {
        ["Header", "GISA Body", "Assessment", "Actions", "Gallery"][rawValue]
    }

    var shortTitle: String {
        ["Header", "Body", "Assess", "Actions", "Gallery"][rawValue]
    }

    static let headerKeys: Set = ["report_date", "district", "county", "route", "post_mile", "ea", "project_id",
                                  "date_incident_reported", "district_contact", "latitude", "longitude", "geometry_json"]
    /// Body fields already editable here, so not repeated as saved values.
    static let portedBodyKeys = Set(["distribution_code", "highway_status_cause", "highway_status_code",
                                     "lanes_closed_count", "incident_type_description"])
        .union(GisaForm.incidentTypeCodes.map(\.key))
        .union(["material_rock", "material_soil", "material_bedding", "material_joints", "material_fractures",
                "material_pavement_type", "est_soil_pct", "est_rock_pct", "est_clay_pct", "est_silt_pct"])
        .union(GisaEditor.soilShareKeys).union(GisaEditor.debrisShareKeys)
    static let assessmentKeys: Set = ["record_of_event_notes", "maintenance_history_notes", "observations_notes",
                                      "geotechnical_assessment_notes", "sketchpad_notes"]

    /// Whether any of these field keys is on this step.
    func owns<S: Sequence>(_ keys: S) -> Bool where S.Element == String {
        guard self == .header else { return false }
        return keys.contains { Self.headerKeys.contains($0) }
    }

    /// The saved GISA columns this step shows while it is not yet editable here.
    func showsSavedValue(_ key: String) -> Bool {
        switch self {
        case .assessment: return Self.assessmentKeys.contains(key)
        case .body: return !Self.headerKeys.contains(key) && !Self.assessmentKeys.contains(key) && !key.hasSuffix("_html")
            && !Self.portedBodyKeys.contains(key)
            && !["submission_id", "location_id", "updated_by_user_id", "revision", "created_at", "updated_at"].contains(key)
        default: return false
        }
    }
}

// MARK: - Step 1: Header and Location

struct GisaHeaderSections: View {
    @Environment(\.openURL) private var openURL
    @Binding var editor: GisaEditor
    let canEdit: Bool
    @State private var showCoordinates = false
    @State private var showNorthingEasting = false
    @State private var northing = ""
    @State private var easting = ""
    @State private var statePlaneError: String?
    @State private var openContacts: Set<UUID> = []

    private var form: GisaForm { editor.form }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    var body: some View {
        Section("GISA Header") {
            GisaDateField(label: "Report Date", value: binding("report_date"), editable: canEdit,
                          error: editor.errors["report_date"])
            GisaChoiceField(label: "District *", value: form["district"], editable: canEdit,
                            options: CaltransCounties.districts.map { ($0, "District \($0)") },
                            placeholder: "Select district", error: editor.errors["district"]) { editor.chooseDistrict($0) }
            GisaChoiceField(label: "County *", value: form["county"], editable: canEdit && !form["district"].isEmpty,
                            options: CaltransCounties.counties(inDistrict: form["district"]).map { ($0.code, $0.displayLabel) },
                            placeholder: form["district"].isEmpty ? "Select district first" : "Select county",
                            error: editor.errors["county"]) { editor.chooseCounty($0) }
            GisaChoiceField(label: "Route", value: form["route"], editable: canEdit && !form["county"].isEmpty,
                            options: CaltransCounties.routes(forCounty: form["county"]).map { ($0, $0) },
                            placeholder: form["county"].isEmpty ? "Select county first" : "Select route",
                            error: editor.errors["route"]) { editor.set("route", $0) }
            GisaTextField(label: "Post Mile", value: binding("post_mile"), editable: canEdit,
                          keyboard: .decimalPad, error: editor.errors["post_mile"]) {
                editor.set("post_mile", GisaPrecision.postMileInput(form["post_mile"]))
            }
            GisaTextField(label: "EA", value: binding("ea"), editable: canEdit, error: editor.errors["ea"])
            GisaTextField(label: "Project ID", value: binding("project_id"), editable: canEdit, keyboard: .numberPad,
                          error: editor.errors["project_id"])
            GisaDateField(label: "Date Incident Reported", value: binding("date_incident_reported"),
                          editable: canEdit, error: editor.errors["date_incident_reported"])
        }

        Section {
            if editor.contacts.isEmpty {
                Text("No district contacts added yet.").foregroundStyle(.secondary)
            }
            ForEach(Array(editor.contacts.enumerated()), id: \.element.id) { index, contact in
                DisclosureGroup(isExpanded: Binding(get: { openContacts.contains(contact.id) },
                                                    set: { if $0 { openContacts.insert(contact.id) } else { openContacts.remove(contact.id) } })) {
                    contactField("First Name", \.firstName, index)
                    contactField("Last Name", \.lastName, index)
                    contactField("S Number", \.sNumber, index)
                    contactField("Phone", \.phone, index, keyboard: .phonePad)
                    contactField("Cell Phone", \.cellPhone, index, keyboard: .phonePad)
                    if canEdit {
                        Button("Remove Contact", role: .destructive) {
                            editor.setContacts(editor.contacts.filter { $0.id != contact.id })
                        }
                    }
                } label: {
                    Text(contact.displayName(index: index))
                }
            }
            if canEdit {
                Button("Add District Contact") {
                    let added = DistrictContact()
                    editor.setContacts(editor.contacts + [added])
                    openContacts.insert(added.id)
                }
            }
        } header: {
            Text("District Contacts")
        } footer: {
            if let message = editor.errors["district_contact"] { Text(message).foregroundStyle(.red) }
        }

        Section("Location") {
            VStack(alignment: .leading, spacing: 6) {
                if let preview = form.mapPreviewURL {
                    AsyncImage(url: preview) { image in
                        image.resizable().aspectRatio(2, contentMode: .fit)
                    } placeholder: {
                        Color.gray.opacity(0.15).aspectRatio(2, contentMode: .fit)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel("Satellite view of the location")
                } else {
                    Text("Awaiting location…").foregroundStyle(.secondary)
                }
                Text("Geometry: \(form["geometry_json"].trimmingCharacters(in: .whitespaces).isEmpty ? "None" : "Available")")
                    .font(.caption).foregroundStyle(.secondary)
                // The Expo app opens its ArcGIS map editor from this preview; that
                // and the Site Photo Map come with the ArcGIS Maps SDK port.
                Text("The map editor (pin and polygon) is not on iPhone yet. Set the location with Lat/Lon or Northing/Easting below.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Button("Open in Google Maps") { if let url = form.googleMapsURL { openURL(url) } }
                .disabled(form.googleMapsURL == nil)
            Toggle("Show Lat/Lon", isOn: $showCoordinates)
            if showCoordinates || editor.errors["latitude"] != nil || editor.errors["longitude"] != nil {
                GisaTextField(label: "Latitude *", value: binding("latitude"), editable: canEdit,
                              keyboard: .numbersAndPunctuation, error: editor.errors["latitude"]) {
                    editor.set("latitude", GisaPrecision.formatCoordinate(form["latitude"]))
                }
                GisaTextField(label: "Longitude *", value: binding("longitude"), editable: canEdit,
                              keyboard: .numbersAndPunctuation, error: editor.errors["longitude"]) {
                    editor.set("longitude", GisaPrecision.formatCoordinate(form["longitude"]))
                }
            }
            Toggle("Show Northing/Easting", isOn: $showNorthingEasting)
                .disabled(form.statePlane == nil)
            if showNorthingEasting, let plane = form.statePlane {
                Text("CCS83 Zone \(plane.zone) · US survey ft").font(.caption).foregroundStyle(.secondary)
                GisaTextField(label: "Northing", value: $northing, editable: canEdit, keyboard: .numbersAndPunctuation,
                              error: statePlaneError) { applyStatePlane() }
                GisaTextField(label: "Easting", value: $easting, editable: canEdit, keyboard: .numbersAndPunctuation,
                              error: nil) { applyStatePlane() }
            }
        }
        .onAppear(perform: refreshStatePlane)
        .onChange(of: "\(form["latitude"])|\(form["longitude"])|\(form["county"])") { refreshStatePlane() }
    }

    private func contactField(_ label: String, _ path: WritableKeyPath<DistrictContact, String>, _ index: Int,
                              keyboard: UIKeyboardType = .default) -> some View {
        GisaTextField(label: label, value: Binding(get: { editor.contacts[index][keyPath: path] }, set: { value in
            var next = editor.contacts
            next[index][keyPath: path] = value
            editor.setContacts(next)
        }), editable: canEdit, keyboard: keyboard, error: nil)
    }

    private func refreshStatePlane() {
        northing = form.statePlane?.northing ?? ""
        easting = form.statePlane?.easting ?? ""
        statePlaneError = nil
    }

    private func applyStatePlane() {
        var next = editor.form
        if let problem = next.applyStatePlane(northing: northing, easting: easting) {
            statePlaneError = problem
            return
        }
        editor.set("latitude", next["latitude"])
        editor.set("longitude", next["longitude"])
        refreshStatePlane()
    }
}

// MARK: - Step 2: GISA Body

struct GisaBodySections: View {
    @Binding var editor: GisaEditor
    let canEdit: Bool
    let lookups: GisaLookups

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { editor.form[key] }, set: { editor.set(key, $0) })
    }

    var body: some View {
        Section("Distribution") {
            ChipFlow {
                ForEach(lookups.distribution) { option in
                    GisaChip(label: option.label, icon: "Distribution/\(option.code)",
                             on: editor.form["distribution_code"] == option.code, enabled: canEdit) {
                        editor.toggleDistribution(option.code)
                    }
                }
            }
            GisaSectionPhotos(sectionKey: "distribution")
        }

        Section {
            GisaTextField(label: "Cause Of Highway Status", value: binding("highway_status_cause"), editable: canEdit,
                          error: editor.errors["highway_status_cause"])
            if editor.showsHighwayStatusOptions {
                ChipFlow {
                    ForEach(lookups.highwayStatus) { option in
                        GisaChip(label: option.label, on: editor.form["highway_status_code"] == option.code,
                                 enabled: canEdit) { editor.toggleHighwayStatus(option.code) }
                    }
                }
                if editor.asksLanesClosedCount {
                    GisaChoiceField(label: "Lane(s) Closed Count", value: editor.form["lanes_closed_count"],
                                    editable: canEdit, options: GisaEditor.lanesClosedCounts.map { ($0, $0) },
                                    placeholder: "Select lanes closed", error: editor.errors["lanes_closed_count"]) {
                        editor.set("lanes_closed_count", $0)
                    }
                }
            } else {
                Text("Enter the cause above to reveal the highway status options.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            GisaSectionPhotos(sectionKey: "highway_status")
        } header: {
            Text("Highway Status")
        }

        Section("Incident Type") {
            ChipFlow {
                ForEach(GisaEditor.incidentTypeOptions) { option in
                    GisaChip(label: option.label, on: editor.isIncidentTypeOn(option), enabled: canEdit) {
                        editor.toggleIncidentType(option)
                    }
                }
            }
            GisaTextField(label: "Incident Type Description", value: binding("incident_type_description"),
                          editable: canEdit, error: editor.errors["incident_type_description"], axis: .vertical)
            GisaSectionPhotos(sectionKey: "incident_type")
        }

        GisaMaterialSection(editor: $editor, canEdit: canEdit)
    }
}

/// Material: slope (soil and rock formation), pavement type and landslide debris.
struct GisaMaterialSection: View {
    @Binding var editor: GisaEditor
    let canEdit: Bool
    @State private var part = Part.slope

    enum Part: String, CaseIterable, Identifiable {
        case slope = "Slope", pavement = "Pavement", debris = "Landslide Debris"
        var id: String { rawValue }
    }

    private func slider(_ label: String, _ key: String) -> some View {
        GisaPercentSlider(label: label, value: GisaEditor.steppedPercent(editor.form[key]), enabled: canEdit) {
            editor.setPercent(key, $0)
        }
    }

    var body: some View {
        Section {
            Picker("Material", selection: $part) {
                ForEach(Part.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            switch part {
            case .slope:
                Toggle("Soil", isOn: Binding(get: { editor.form["material_soil"] == "YES" },
                                             set: { _ in editor.toggleMaterial("material_soil") }))
                    .disabled(!canEdit)
                if editor.form["material_soil"] == "YES" {
                    slider("Soil Est %", "est_soil_pct")
                    GisaPercentSlider(label: "Clay/Silt Est %", value: GisaEditor.steppedPercent(editor.claySiltPercent),
                                      enabled: canEdit) { editor.setClaySiltPercent($0) }
                    slider("Sand Est %", "est_sand_pct")
                    slider("Gravel/Cobbles Est %", "est_gravel_pct")
                    slider("Boulder Est %", "est_boulder_pct")
                    GisaShareTotal(what: "Clay/silt, sand, gravel/cobbles and boulder", total: editor.soilShareTotal)
                }
                Toggle("Rock Formation", isOn: Binding(get: { editor.form["material_rock"] == "YES" },
                                                       set: { _ in editor.toggleMaterial("material_rock") }))
                    .disabled(!canEdit)
                if editor.form["material_rock"] == "YES" {
                    slider("Rock Formation Est %", "est_rock_pct")
                    ChipFlow {
                        ForEach(GisaEditor.rockSubtypes, id: \.0) { key, label in
                            GisaChip(label: label, on: editor.form[key] == "YES", enabled: canEdit) {
                                editor.toggleRockSubtype(key)
                            }
                        }
                    }
                }
            case .pavement:
                ChipFlow {
                    ForEach([("CONCRETE", "Concrete"), ("ASPHALT", "Asphalt")], id: \.0) { code, label in
                        GisaChip(label: label, on: editor.form["material_pavement_type"] == code, enabled: canEdit) {
                            editor.togglePavementType(code)
                        }
                    }
                }
            case .debris:
                slider("Clay/Silt Est %", "est_debris_clay_silt_pct")
                slider("Sand Est %", "est_debris_sand_pct")
                slider("Gravel/Cobbles Est %", "est_debris_gravel_pct")
                slider("Boulder Est %", "est_debris_boulder_pct")
                GisaShareTotal(what: "Landslide debris", total: editor.debrisShareTotal)
            }
            GisaSectionPhotos(sectionKey: "material")
        } header: {
            Text("Material")
        }
    }
}

/// A 0–100% share in steps of 5, as the Expo editor's SteppedPercentInput.
struct GisaPercentSlider: View {
    let label: String
    let value: Int
    let enabled: Bool
    let change: (Double) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                Spacer()
                Text("\(value)%").monospacedDigit().foregroundStyle(.secondary)
            }
            Slider(value: Binding(get: { Double(value) }, set: change), in: 0...100, step: 5) {
                Text(label)
            } minimumValueLabel: {
                Text("0%").font(.caption2).foregroundStyle(.secondary)
            } maximumValueLabel: {
                Text("100%").font(.caption2).foregroundStyle(.secondary)
            }
            .disabled(!enabled)
            .sensoryFeedback(.selection, trigger: value)
        }
    }
}

/// The running total of a group of shares, which must reach 100% to submit.
struct GisaShareTotal: View {
    let what: String
    let total: Double?

    var body: some View {
        if let total {
            let done = total == 100
            Label("\(what): \(JSNumberText.text(total))% of 100%", systemImage: done ? "checkmark.circle" : "exclamationmark.circle")
                .font(.footnote)
                .foregroundStyle(done ? Color.green : Color.secondary)
        } else {
            Label("\(what): a share is not a number", systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(.red)
        }
    }
}

/// 80 -> "80", 72.5 -> "72.5".
enum JSNumberText {
    static func text(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.2f", value)
    }
}

/// A choice shown as a capsule that is on or off, as the Expo editor's Chip.
struct GisaChip: View {
    let label: String
    var icon: String?
    let on: Bool
    let enabled: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                if let icon, UIImage(named: icon) != nil {
                    Image(icon).resizable().scaledToFit().frame(width: 22, height: 22)
                }
                Text(label).font(.subheadline.weight(on ? .semibold : .regular))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(on ? Color.white : Color.primary)
            .background(on ? Color.accentColor : Color.secondary.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled || on ? 1 : 0.6)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Lays chips out in rows, wrapping at the edge.
struct ChipFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0,
                      height: rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if let last = rows.last, last.width + spacing + size.width <= width {
                rows[rows.count - 1] = (last.indices + [index], last.width + spacing + size.width, max(last.height, size.height))
            } else {
                rows.append(([index], size.width, size.height))
            }
        }
        return rows
    }
}

// MARK: - Steps not yet ported, and the gallery

/// The saved values of a step that is not editable on iPhone yet.
struct GisaSavedValuesSection: View {
    let detail: SubmissionDetail
    let step: GisaStep

    var body: some View {
        Section {
            Text(step == .body
                 ? "The rest of this step is being ported to iPhone. Its saved values are shown below, and saving keeps them as they are."
                 : "This step is being ported to iPhone. Its saved values are shown here, and saving keeps them as they are.")
                .font(.callout).foregroundStyle(.secondary)
        }
        if let gisa = detail.gisa, gisa.keys.contains(where: step.showsSavedValue) {
            Section("Saved values") {
                ForEach(gisa.keys.filter(step.showsSavedValue).sorted(), id: \.self) { key in
                    if let value = gisa[key].flatMap(SubmissionLabels.text) {
                        LabeledContent(SubmissionLabels.fieldName(key), value: value)
                    }
                }
            }
        }
        if step == .actions, let actions = detail.actions {
            Section("Saved actions") {
                LabeledContent("Immediate", value: actions.immediate.isEmpty ? "None" : actions.immediate.joined(separator: ", "))
                LabeledContent("Follow-up", value: actions.followUp.isEmpty ? "None" : actions.followUp.joined(separator: ", "))
            }
        }
    }
}

struct GisaGallerySection: View {
    let detail: SubmissionDetail
    let openPDF: () -> Void

    var body: some View {
        Section("Photos") {
            if let photos = detail.photos, !photos.isEmpty {
                ScrollView(.horizontal) {
                    HStack { ForEach(photos) { AttachmentThumbnail(attachment: $0) } }
                }
            } else {
                Text("No photos yet.").foregroundStyle(.secondary)
            }
        }
        Section {
            Button("Open latest GISA PDF", action: openPDF)
        }
    }
}

// MARK: - Fields

/// A labelled text field with its error. `onEndEditing` runs when the field
/// loses focus or Return is pressed, where the Expo editor normalised on blur.
struct GisaTextField: View {
    let label: String
    @Binding var value: String
    var editable = true
    var keyboard: UIKeyboardType = .default
    let error: String?
    var axis: Axis = .horizontal
    var onEndEditing: (() -> Void)?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            // The label sits above the field, so it is not repeated inside it.
            TextField(label, text: $value, prompt: Text(""), axis: axis)
                .accessibilityLabel(label)
                .keyboardType(keyboard)
                .focused($focused)
                .disabled(!editable)
                .foregroundStyle(editable ? .primary : .secondary)
                .onSubmit { onEndEditing?() }
                .onChange(of: focused) { _, now in if !now { onEndEditing?() } }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
}

/// A choice from a fixed list, shown as a menu. A saved value that is not in
/// the list is kept and shown, not silently dropped.
struct GisaChoiceField: View {
    let label: String
    let value: String
    let editable: Bool
    let options: [(value: String, title: String)]
    let placeholder: String
    let error: String?
    let choose: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Menu {
                ForEach(options, id: \.value) { option in
                    Button { choose(option.value) } label: {
                        if option.value == value { Label(option.title, systemImage: "checkmark") } else { Text(option.title) }
                    }
                }
            } label: {
                HStack {
                    Text(label).foregroundStyle(.primary)
                    Spacer()
                    Text(options.first { $0.value == value }?.title ?? (value.isEmpty ? placeholder : value))
                        .foregroundStyle(value.isEmpty ? .tertiary : .secondary)
                    if editable { Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.tertiary) }
                }
            }
            .disabled(!editable)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
}

/// A YYYY-MM-DD date, chosen on a calendar; it can be left blank.
struct GisaDateField: View {
    let label: String
    @Binding var value: String
    let editable: Bool
    let error: String?
    @State private var choosing = false
    @State private var draft = Date()

    private static let format: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button {
                draft = Self.format.date(from: value) ?? Date()
                choosing = true
            } label: {
                HStack {
                    Text(label).foregroundStyle(.primary)
                    Spacer()
                    Text(value.isEmpty ? "Select date" : value).foregroundStyle(value.isEmpty ? .tertiary : .secondary)
                }
            }
            .disabled(!editable)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .sheet(isPresented: $choosing) {
            NavigationStack {
                DatePicker(label, selection: $draft, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .padding()
                    .navigationTitle(label)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Clear") { value = ""; choosing = false }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { value = Self.format.string(from: draft); choosing = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        }
    }
}
