import AVFoundation
import ERISKit
import PhotosUI
import SwiftUI

/// Report an incident from the field: location from GPS (District / County /
/// Route / Post mile from the road data on this iPhone, else the Caltrans
/// postmile layer online), a description, photos and videos. Ported from
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
    @State private var picked: [PhotosPickerItem] = []
    @State private var media: [ReportMedia] = []
    @State private var capturing: ReportCapture?
    /// How many are being prepared; Submit waits for them.
    @State private var preparing = 0
    @State private var confirmingCancel = false
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
            Section {
                if ReportCapture.available {
                    Button { open(.photo) } label: { Label("Take Photo", systemImage: "camera") }
                        .disabled(isFull)
                    Button { open(.video) } label: { Label("Record Video", systemImage: "video") }
                        .disabled(isFull)
                }
                PhotosPicker(selection: $picked, maxSelectionCount: max(1, ReportMediaFiles.limit - media.count),
                             matching: .any(of: [.images, .videos])) {
                    Label("Photo or Video Library", systemImage: "photo.on.rectangle")
                }
                .disabled(isFull)
                ForEach(media) { item in
                    ReportMediaRow(media: item, title: title(of: item)) { remove(item) }
                }
                if preparing > 0 {
                    HStack {
                        ProgressView()
                        Text("Preparing…").foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Photos and Videos")
            } footer: {
                Text("Up to \(ReportMediaFiles.limit). A recording stops at \(Int(ReportMediaFiles.maxRecordingSeconds / 60)) minutes.")
            }
            if let status {
                Section { Text(status).foregroundStyle(.secondary) }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .keyboardDoneButton()
        .navigationTitle("Report incident")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    if media.isEmpty { dismiss() } else { confirmingCancel = true }
                }
                // What the camera took is nowhere else, so it is not lost to a stray tap.
                .confirmationDialog("Discard this report?", isPresented: $confirmingCancel, titleVisibility: .visible) {
                    Button("Discard", role: .destructive) {
                        media.forEach { $0.discard() }
                        dismiss()
                    }
                } message: {
                    Text("The photos and videos taken for it are not saved anywhere else.")
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(busy ? "Sending…" : "Submit") { Task { await submit() } }.disabled(busy || preparing > 0)
            }
        }
        .interactiveDismissDisabled(!media.isEmpty || preparing > 0)
        .fullScreenCover(item: $capturing) { mode in
            SystemCamera(mode: mode) { taken in
                capturing = nil
                if let taken { Task { await add(taken) } }
            }
            .ignoresSafeArea()
        }
        .onChange(of: picked) {
            guard !picked.isEmpty else { return }
            let items = picked
            picked = []
            Task { await addFromLibrary(items) }
        }
        .task {
            if media.isEmpty && preparing == 0 { ReportMediaFiles.clearLeftovers() }
        }
    }

    private var isFull: Bool { media.count + preparing >= ReportMediaFiles.limit }

    /// "Photo 2", "Video 1".
    private func title(of item: ReportMedia) -> String {
        let same = media.filter { $0.kind == item.kind }
        let number = (same.firstIndex { $0.id == item.id } ?? 0) + 1
        return "\(item.isVideo ? "Video" : "Photo") \(number)"
    }

    private func remove(_ item: ReportMedia) {
        item.discard()
        media.removeAll { $0.id == item.id }
    }

    private func open(_ mode: ReportCapture) {
        #if DEBUG
        if ReportCapture.isDemo {
            Task { await add(DemoCamera.take(mode)) }
            return
        }
        #endif
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            status = "Camera access is off. Allow it in Settings, or choose from the library."
        default:
            capturing = mode
        }
    }

    private func add(_ taken: SystemCamera.Taken?) async {
        guard let taken else { status = "The demo camera could not make a file."; return }
        preparing += 1
        defer { preparing -= 1 }
        do {
            switch taken {
            case .photo(let image): media.append(try ReportMediaFiles.photo(image))
            case .video(let url): media.append(try await ReportMediaFiles.video(from: url))
            }
        } catch {
            status = error.localizedDescription
        }
    }

    private func addFromLibrary(_ items: [PhotosPickerItem]) async {
        preparing += items.count
        var unreadable = 0
        var problem: String?
        for item in items {
            defer { preparing -= 1 }
            do {
                if let added = try await ReportMediaFiles.fromLibrary(item) { media.append(added) } else { unreadable += 1 }
            } catch let error as ReportMediaFiles.Problem {
                problem = error.message
            } catch {
                unreadable += 1
            }
        }
        if let problem {
            status = problem
        } else if unreadable > 0 {
            status = "\(unreadable) could not be read."
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
        // Each goes to the report's folder in turn, so long videos are never all in memory.
        var files: [QueuedIncident.File] = []
        let report = UUID()
        var counts: [IncidentAttachmentKind: Int] = [:]
        for item in media {
            guard let data = try? Data(contentsOf: item.file, options: .mappedIfSafe) else { continue }
            counts[item.kind, default: 0] += 1
            let name = "\(item.isVideo ? "video" : "photo")-\(counts[item.kind]!).\(item.file.pathExtension)"
            let file = QueuedIncident.File(fileName: name, mimeType: item.mimeType, kind: item.kind)
            offline.store.queueIncidentFile(data, incident: report, file: file.id)
            files.append(file)
        }
        let skipped = media.count > files.count ? " \(media.count - files.count) could not be read." : ""
        status = "Sending…"
        let (outcome, kept) = await offline.file(QueuedIncident(draft: draft, files: files, id: report), files: [:])
        switch outcome {
        case .sent, .nothing:
            media.forEach { $0.discard() }
            onDone("Report filed.\(skipped)")
            dismiss()
        case .unreachable:
            media.forEach { $0.discard() }
            onDone("ERIS can't be reached. The report is kept on this iPhone and filed when the connection returns.\(skipped)")
            dismiss()
        case .refused(let why):
            if let kept, kept.serverId == nil {
                // Not filed: fix it here and send again.
                offline.store.removeIncident(kept)
                offline.refresh()
                status = why
            } else {
                media.forEach { $0.discard() }
                onDone("Report filed, but a photo or video was refused: \(why)")
                dismiss()
            }
        }
    }
}
