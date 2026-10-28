import ERISKit
import SwiftUI

/// The incidents this person can see on the phone (`GET /incidents?scope=mobile`).
struct IncidentsView: View {
    @EnvironmentObject private var model: AppModel
    let me: Me
    @State private var incidents: [Incident] = []
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.red)
            }
            ForEach(incidents) { incident in
                NavigationLink(value: incident.id) {
                    IncidentRow(incident: incident)
                }
            }
            if !loading && incidents.isEmpty && error == nil {
                Text("No incidents to show.").foregroundStyle(.secondary)
            }
        }
        .overlay { if loading && incidents.isEmpty { ProgressView() } }
        .navigationTitle("Incidents")
        .navigationDestination(for: Int.self) { IncidentDetailView(incidentId: $0) }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            incidents = try await model.api.get("/incidents", query: [URLQueryItem(name: "scope", value: "mobile")],
                                                as: IncidentList.self).items
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }
}

struct IncidentRow: View {
    let incident: Incident

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(incident.displayTitle).font(.headline)
            if !incident.locationLine.isEmpty {
                Text(incident.locationLine).font(.subheadline).foregroundStyle(.secondary)
            }
            HStack {
                StatusChip(text: IncidentLabels.status(incident.status))
                Text(IncidentLabels.stage(incident.currentStage)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct StatusChip: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(.blue.opacity(0.12), in: Capsule())
    }
}

struct IncidentDetailView: View {
    @EnvironmentObject private var model: AppModel
    let incidentId: Int
    @State private var incident: Incident?
    @State private var error: String?

    var body: some View {
        Group {
            if let incident {
                List {
                    Section {
                        LabeledContent("Status", value: IncidentLabels.status(incident.status))
                        LabeledContent("Stage", value: IncidentLabels.stage(incident.currentStage))
                        if let type = incident.incidentType { LabeledContent("Type", value: type) }
                        if !incident.locationLine.isEmpty { LabeledContent("Location", value: incident.locationLine) }
                        if let observed = incident.firstObservedAt { LabeledContent("Observed", value: observed) }
                        if let name = incident.assignment?.assigneeName { LabeledContent("Assigned to", value: name) }
                    }
                    if let description = incident.description, !description.isEmpty {
                        Section("Description") { Text(description) }
                    }
                    if let resolution = incident.resolutionComment, !resolution.isEmpty {
                        Section("Resolution") { Text(resolution) }
                    }
                }
                .navigationTitle(incident.displayTitle)
            } else if let error {
                Text(error).foregroundStyle(.red).padding()
            } else {
                ProgressView()
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            incident = try await model.api.get("/incidents/\(incidentId)", as: Incident.self)
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }
}

/// The same feed as the web portal's bell.
struct NotificationsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var feed: [FeedItem] = []
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(feed) { item in
                Button {
                    Task { await open(item) }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title).font(item.read ? .body : .body.weight(.semibold))
                        if let body = item.body, !body.isEmpty {
                            Text(body).font(.subheadline).foregroundStyle(.secondary)
                        }
                        if let created = item.createdAt {
                            Text(created).font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                }
                .foregroundStyle(.primary)
            }
            if feed.isEmpty && error == nil {
                Text("Nothing new.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Notifications")
        .toolbar {
            if model.unread > 0 {
                Button("Mark all read") { Task { await markAllRead() } }
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            let result = try await model.api.get("/notifications", query: [URLQueryItem(name: "limit", value: "50")],
                                                 as: Feed.self)
            feed = result.items
            model.unread = result.unread
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }

    private func open(_ item: FeedItem) async {
        if !item.read {
            if let count = try? await model.api.post("/notifications/read", json: ["ids": [item.id]], as: UnreadCount.self) {
                model.unread = count.unread
            }
        }
        model.pendingRoute = NotificationRoutes.route(link: item.link, kind: item.kind)
        await load()
    }

    private func markAllRead() async {
        if let count = try? await model.api.post("/notifications/read", json: [String: [Int]](), as: UnreadCount.self) {
            model.unread = count.unread
        }
        await load()
    }
}
