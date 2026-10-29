import ERISKit
import SwiftUI

/// Report: a maintenance reporter's tool. Report an incident, and follow the
/// reports they filed (one sent back for more information also waits in My Work).
struct ReportsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var offline: OfflineSync
    let me: Me
    @State private var items: [MyReports.Item] = []
    @State private var error: String?
    @State private var loading = false
    @State private var reporting = false
    @State private var notice: String?

    var body: some View {
        List {
            if let notice {
                Section { Label(notice, systemImage: "checkmark.circle").foregroundStyle(.green).font(.subheadline) }
            }
            Section {
                Button {
                    reporting = true
                } label: {
                    Label("Report an Incident", systemImage: "plus.circle.fill").font(.headline)
                }
            }
            OfflineStatusSection(keptAt: nil)
            if !offline.waiting.incidents.isEmpty {
                Section("Waiting to send") {
                    ForEach(offline.waiting.incidents) { report in
                        HStack(alignment: .top) {
                            Image(systemName: report.problem == nil ? "clock.arrow.circlepath" : "exclamationmark.circle")
                                .foregroundStyle(report.problem == nil ? Color.secondary : Color.orange)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(report.title).font(.headline)
                                Text(report.problem ?? "Kept on this iPhone\(report.files.isEmpty ? "" : " with \(report.files.count) photo\(report.files.count == 1 ? "" : "s")")")
                                    .font(.caption).foregroundStyle(report.problem == nil ? Color.secondary : Color.orange)
                            }
                            Spacer()
                            if report.problem != nil {
                                Button("Discard", role: .destructive) {
                                    offline.store.removeIncident(report)
                                    offline.refresh()
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            Section("My reports") {
                ForEach(items) { item in
                    switch item {
                    case .incident(let incident):
                        NavigationLink(value: ReportRoute(id: incident.id, inWorkflow: false)) { IncidentRow(incident: incident) }
                    case .maintenance(let report):
                        NavigationLink(value: ReportRoute(id: report.id, inWorkflow: true)) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(report.title ?? "Report #\(report.id)").font(.headline)
                                HStack {
                                    StatusChip(text: report.status)
                                    if report.myTurn { Text("Your action needed").font(.caption.weight(.semibold)).foregroundStyle(.orange) }
                                }
                            }
                        }
                    }
                }
                if !loading && items.isEmpty && error == nil {
                    Text("Reports you file appear here.").foregroundStyle(.secondary)
                }
            }
        }
        .overlay { if loading && items.isEmpty { ProgressView() } }
        .navigationTitle("Report")
        .navigationDestination(for: ReportRoute.self) { route in
            if route.inWorkflow {
                MaintenanceReportView(incidentId: route.id) { message in
                    notice = message
                    Task { await load() }
                }
            } else {
                ReportDetailView(incidentId: route.id)
            }
        }
        .sheet(isPresented: $reporting) {
            NavigationStack {
                CreateIncidentView { message in
                    notice = message
                    Task { await load() }
                }
            }
        }
        .refreshable {
            offline.kick()
            await load()
        }
        .task { await load() }
        // A kept report filed: it joins the list.
        .onChange(of: offline.rounds) { Task { await load() } }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        let incidents = IncidentsAPI(api: model.api)
        do {
            async let filed = incidents.list(limit: 500)
            async let workflow = incidents.maintenanceReports()
            let reports = (try? await workflow) ?? []
            items = MyReports.items(incidents: try await filed, maintenance: reports, me: me.id)
            error = nil
        } catch let failure as APIError where failure.isUnreachable {
            error = items.isEmpty ? "Your reports can't be listed without a connection. New reports are kept on this iPhone." : nil
        } catch {
            self.error = model.handle(error)
        }
    }
}

/// A report this person filed, opened from the Report tab.
struct ReportRoute: Hashable {
    let id: Int
    let inWorkflow: Bool
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

/// A report, read only: where it stands, what was reported, its evidence.
/// Decisions on it are made in My Work.
struct ReportDetailView: View {
    @EnvironmentObject private var model: AppModel
    let incidentId: Int
    @State private var incident: Incident?
    @State private var evidence: [IncidentEvidence]?
    @State private var error: String?

    var body: some View {
        Group {
            if let incident {
                List {
                    Section {
                        LabeledContent("Status", value: IncidentLabels.status(incident.status))
                        LabeledContent("Stage", value: IncidentLabels.stage(incident.currentStage))
                        if let resolution = incident.resolutionComment, !resolution.isEmpty {
                            Text(resolution).font(.callout)
                        }
                    }
                    ReportFactsSection(incident: incident)
                    EvidenceSection(items: evidence)
                }
                .navigationTitle("Report #\(incident.id)")
                .navigationBarTitleDisplayMode(.inline)
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
        let incidents = IncidentsAPI(api: model.api)
        do {
            incident = try await incidents.get(incidentId)
            evidence = (try? await incidents.evidence(incidentId)) ?? []
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }
}

/// The same feed as the web portal's bell.
struct NotificationsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var offline: OfflineSync
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
        // New notices appear without pulling to refresh.
        .onChange(of: offline.rounds) { Task { await load() } }
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
