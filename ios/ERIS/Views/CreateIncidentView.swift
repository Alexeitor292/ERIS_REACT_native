import ERISKit
import PhotosUI
import SwiftUI

/// Report an incident from the field: location from GPS (District / County /
/// Route / Post mile from the Caltrans postmile layer), a description, photos.
/// Ported from mobile/src/components/CreateIncidentScreen.tsx (online path;
/// the offline road-inventory lookup arrives with the offline phase).
struct CreateIncidentView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var onCreated: (Incident) -> Void

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
            } header: {
                Text("Location")
            } footer: {
                Text("District, county, route and post mile come from the Caltrans postmile layer for your location. Check them before submitting.")
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
            let url = CaltransPostmile.queryURL(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude)
            let (data, _) = try await URLSession.shared.data(from: url)
            if let road = CaltransPostmile.nearest(in: data, latitude: fix.coordinate.latitude,
                                                   longitude: fix.coordinate.longitude) {
                district = road.district
                county = road.county
                route = road.route
                postMile = road.postMile
                status = "Nearest post mile is \(Int(road.distanceMeters)) m away."
            } else {
                status = "No Caltrans highway post mile within 3 km. Enter the location by hand."
            }
        } catch LocationProvider.Failure.denied {
            status = "Location access is off. Allow it in Settings, or enter the location by hand."
        } catch {
            status = "The location could not be determined. Enter it by hand."
        }
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
        let incidents = IncidentsAPI(api: model.api)
        do {
            let created = try await incidents.create(draft)
            var failed = 0
            for (index, item) in photos.enumerated() {
                status = "Uploading photo \(index + 1) of \(photos.count)…"
                guard let data = try? await item.loadTransferable(type: Data.self) else { failed += 1; continue }
                do {
                    try await incidents.upload(created.id, file: data, fileName: "photo-\(index + 1).jpg",
                                               mimeType: "image/jpeg", kind: .photo)
                } catch {
                    failed += 1
                }
            }
            if failed > 0 { status = "\(failed) photo(s) did not upload; add them from the incident." }
            onCreated(created)
            dismiss()
        } catch {
            status = model.handle(error)
        }
    }
}
