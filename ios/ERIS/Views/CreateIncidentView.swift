import ERISKit
import PhotosUI
import SwiftUI

/// Report an incident from the field: location from GPS (District / County /
/// Route / Post mile from the road data on this iPhone, else the Caltrans
/// postmile layer online), a description, photos. Ported from
/// mobile/src/components/CreateIncidentScreen.tsx.
struct CreateIncidentView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var roads: RoadData
    @EnvironmentObject private var offline: OfflineSync
    @Environment(\.dismiss) private var dismiss
    /// What became of the report, in a sentence.
    var onDone: (String) -> Void

    @State private var title = ""
    @State private var details = ""
    @State private var observed = Date()
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var district = ""
    @State private var county = ""
    @State private var route = ""
    @State private var postMile = ""
    @State private var photos: [PhotosPickerItem] = []
    @State private var status: String?
    @State private var busy = false
    @State private var locating = false
    private let location = LocationProvider()

    var body: some View {
        Form {
            Section("What happened") {
                TextField("Title (optional)", text: $title)
                TextField("Description", text: $details, axis: .vertical)
                    .lineLimit(3...8)
                DatePicker("First observed", selection: $observed)
            }
            Section {
                Button(locating ? "Locating…" : "Use my location") { Task { await locate() } }
                    .disabled(locating)
                TextField("Latitude", text: $latitude).keyboardType(.numbersAndPunctuation)
                TextField("Longitude", text: $longitude).keyboardType(.numbersAndPunctuation)
                TextField("District", text: $district).keyboardType(.numberPad)
                TextField("County", text: $county).textInputAutocapitalization(.characters)
                TextField("Route", text: $route).keyboardType(.numberPad)
                TextField("Post mile", text: $postMile).textInputAutocapitalization(.characters)
                if roads.reference?.hasLocations == true, latitude.isEmpty || longitude.isEmpty,
                   !county.isEmpty, !route.isEmpty, !postMile.isEmpty {
                    Button("Find the coordinates of this post mile") { findCoordinates() }
                }
                if let road = roadHere { Text(road).font(.caption).foregroundStyle(.secondary) }
            } header: {
                Text("Location")
            } footer: {
                Text("District, county, route and post mile come from the road data on this iPhone, or the Caltrans postmile layer online, for your location. Check them before submitting.")
            }
            Section("Photos") {
                PhotosPicker(selection: $photos, maxSelectionCount: 10, matching: .images) {
                    Label(photos.isEmpty ? "Add photos" : "\(photos.count) selected", systemImage: "photo.on.rectangle")
                }
            }
            if let status {
                Section { Text(status).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Report incident")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(busy ? "Sending…" : "Submit") { Task { await submit() } }.disabled(busy)
            }
        }
    }

    private func locate() async {
        locating = true
        defer { locating = false }
        do {
            let fix = try await location.currentLocation()
            latitude = String(format: "%.6f", fix.coordinate.latitude)
            longitude = String(format: "%.6f", fix.coordinate.longitude)
            status = "Looking up the Caltrans post mile…"
            if let road = await roads.locate(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude) {
                district = road.district
                county = road.county
                route = road.route
                postMile = road.postMile
                status = road.note
            } else {
                status = roads.reference?.hasLocations == true
                    ? "No Caltrans highway post mile within 3 km. Enter the location by hand."
                    : "The post mile could not be found: there is no road data on this iPhone and the online Caltrans service can't be reached. Enter it by hand."
            }
        } catch LocationProvider.Failure.denied {
            status = "Location access is off. Allow it in Settings, or enter the location by hand."
        } catch {
            status = "The location could not be determined. Enter it by hand."
        }
    }

    /// The road at the post mile entered: lanes, surface, speed.
    private var roadHere: String? {
        guard let pm = Double(postMile.filter { $0.isNumber || $0 == "." }), !county.isEmpty, !route.isEmpty,
              let segment = roads.reference?.segments(county: county, route: route, postMile: pm, district: district).first,
              !segment.summary.isEmpty else { return nil }
        return "Road here: \(segment.summary)"
    }

    /// The coordinates of the post mile entered, from the road data on this iPhone.
    private func findCoordinates() {
        guard let fix = roads.reference?.position(district: district, county: county, route: route, postMile: postMile) else {
            status = "That post mile is not in the road data on this iPhone. Check the county, route and post mile."
            return
        }
        latitude = String(format: "%.6f", fix.latitude)
        longitude = String(format: "%.6f", fix.longitude)
        postMile = fix.postMile
        if district.isEmpty { district = fix.district ?? "" }
        status = "Coordinates of the post mile, from the road data on this iPhone."
    }

    private func submit() async {
        let draft = IncidentDraft(
            title: title.isEmpty ? nil : title,
            description: details.isEmpty ? nil : details,
            firstObservedAt: ISO8601DateFormatter().string(from: observed),
            latitude: Double(latitude) ?? 0, longitude: Double(longitude) ?? 0,
            district: district, county: county, route: route, postMile: postMile)
        if let problem = draft.problems.first {
            status = problem
            return
        }
        busy = true
        defer { busy = false }
        // Photos as JPEG, which the web can show; kept with the report until filed.
        var files: [QueuedIncident.File] = [], data: [UUID: Data] = [:], unreadable = 0
        for (index, item) in photos.enumerated() {
            status = "Preparing photo \(index + 1) of \(photos.count)…"
            guard let photo = try? await LibraryPhoto.load(item) else { unreadable += 1; continue }
            let file = QueuedIncident.File(fileName: "photo-\(index + 1).jpg", mimeType: "image/jpeg", kind: .photo)
            files.append(file)
            data[file.id] = photo.jpeg
        }
        status = "Sending…"
        let (outcome, kept) = await offline.file(QueuedIncident(draft: draft, files: files), files: data)
        let skipped = unreadable > 0 ? " \(unreadable) photo\(unreadable == 1 ? "" : "s") could not be read." : ""
        switch outcome {
        case .sent, .nothing:
            onDone("Report filed.\(skipped)")
            dismiss()
        case .unreachable:
            onDone("ERIS can't be reached. The report is kept on this iPhone and filed when the connection returns.\(skipped)")
            dismiss()
        case .refused(let why):
            if let kept, kept.serverId == nil {
                // Not filed: fix it here and send again.
                offline.store.removeIncident(kept)
                offline.refresh()
                status = why
            } else {
                onDone("Report filed, but a photo was refused: \(why)")
                dismiss()
            }
        }
    }
}
