import ERISKit
import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        switch model.phase {
        case .starting:
            ProgressView("Starting ERIS…")
        case .signedOut(let message):
            SignInView(message: message)
        case .signedIn(let me):
            // A stack, not a safe-area inset: pushed navigation bars then lay
            // out below the demo banner instead of under it.
            VStack(spacing: 0) {
                if model.isDemo {
                    Text("Demo data: not connected to ERIS")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 2)
                        .background(.orange)
                        .foregroundStyle(.black)
                }
                if let offline = model.offline {
                    MainTabView(me: me).environmentObject(offline).environmentObject(model.roads)
                }
            }
        }
    }
}

/// Caltrans production signs in through Entra only: no password form.
struct SignInView: View {
    @EnvironmentObject private var model: AppModel
    let message: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("ERIS")
                .font(.system(size: 44, weight: .bold))
            Text("Emergency Response Information System")
                .font(.headline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if let message {
                Text(message)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(.yellow.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
            }
            Button {
                busy = true
                Task {
                    await model.signIn()
                    busy = false
                }
            } label: {
                Text(busy ? "Signing in…" : "Sign in with Caltrans Microsoft Entra")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(busy)
            Spacer()
            Text("Internal Caltrans system. Access is limited to authorized ERIS users.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
    }
}

/// The tabs this person's job needs (AppTab), and nothing to browse.
struct MainTabView: View {
    @EnvironmentObject private var model: AppModel
    let me: Me
    @State private var tab = AppTab.myWork
    @State private var workPath = NavigationPath()
    @State private var reportPath = NavigationPath()
    @State private var formsPath = NavigationPath()

    var body: some View {
        let tabs = AppTab.visible(for: me)
        TabView(selection: $tab) {
            if tabs.contains(.myWork) {
                NavigationStack(path: $workPath) { MyWorkView(me: me, path: $workPath) }
                    .tabItem { Label("My Work", systemImage: "tray.full") }
                    .tag(AppTab.myWork)
            }
            if tabs.contains(.report) {
                NavigationStack(path: $reportPath) { ReportsView(me: me) }
                    .tabItem { Label("Report", systemImage: "exclamationmark.bubble") }
                    .tag(AppTab.report)
            }
            if tabs.contains(.forms) {
                NavigationStack(path: $formsPath) { if let offline = model.offline { SubmissionsView(offline: offline) } }
                    .tabItem { Label("Forms", systemImage: "doc.text") }
                    .tag(AppTab.forms)
            }
            NavigationStack { NotificationsView() }
                .tabItem { Label("Notifications", systemImage: "bell") }
                .badge(NotificationRoutes.badgeText(model.unread) ?? "")
                .tag(AppTab.notifications)
            NavigationStack { AccountView(me: me) }
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(AppTab.account)
        }
        .onAppear { if !tabs.contains(tab) { tab = tabs.first ?? .notifications } }
        .onChange(of: model.pendingRoute) { _, route in
            guard let route else { return }
            model.pendingRoute = nil
            open(route, tabs: tabs)
        }
    }

    /// A tapped notification opens the step it is about, in the tab that does it.
    private func open(_ route: AppRoute, tabs: [AppTab]) {
        switch route {
        case .assessments, .trackIncidents:
            if tabs.contains(.myWork) { tab = .myWork }
        case .maintenance(let incident):
            guard tabs.contains(.myWork) else { return }
            tab = .myWork
            if let incident { workPath = NavigationPath([WorkRoute(.maintenance, incident)]) }
        case .incident(let id):
            if tabs.contains(.report) {
                tab = .report
                reportPath = NavigationPath([ReportRoute(id: id, inWorkflow: false)])
            } else if tabs.contains(.myWork) {
                tab = .myWork
                workPath = NavigationPath([WorkRoute(.incident, id)])
            }
        case .submission(let id):
            if tabs.contains(.forms) {
                tab = .forms
                formsPath = NavigationPath([SubmissionRoute(id: id)])
            } else if tabs.contains(.myWork) {
                tab = .myWork
                var path = NavigationPath()
                path.append(SubmissionRoute(id: id))
                workPath = path
            }
        }
    }
}

struct AccountView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var offline: OfflineSync
    let me: Me
    @State private var confirmingSignOut = false

    var body: some View {
        List {
            Section("Signed in") {
                LabeledContent("Name", value: me.fullName)
                LabeledContent("Email", value: me.email)
                if let office = me.org?.officeShortName ?? me.org?.officeName {
                    LabeledContent("Office", value: office)
                }
            }
            Section("Roles") {
                ForEach(me.roles, id: \.self) { Text(RoleModel.label($0)) }
            }
            Section("Server") {
                Text(model.api.baseURL.absoluteString)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
            if !RoleModel.isPublicOnly(me.roles) || me.reportsForMaintenance { RoadDataSection() }
            #if DEBUG
            if model.isDemo { DemoNetworkSection() }
            #endif
            Section {
                Button("Sign out", role: .destructive) {
                    if offline.waiting.isEmpty { Task { await model.signOut() } } else { confirmingSignOut = true }
                }
                .confirmationDialog("Sign out and delete unsent work?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                    Button("Sign Out and Delete", role: .destructive) { Task { await model.signOut() } }
                } message: {
                    Text("\(offline.waiting.summary ?? "Some work is waiting to send"). Signing out deletes it from this iPhone. Connect to ERIS first to send it.")
                }
            } footer: {
                Text("Signs this iPhone out of ERIS and deletes the forms kept on it. Your other devices stay signed in.")
            }
        }
        .navigationTitle("Account")
    }
}

/// The road data on this iPhone, for finding post miles without a connection.
struct RoadDataSection: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var roads: RoadData

    var body: some View {
        Section {
            if let meta = roads.meta {
                LabeledContent("Version", value: meta.versionTag)
                LabeledContent("Post mile points", value: meta.pointCount.formatted())
                LabeledContent("Updated", value: meta.syncedAt.formatted(date: .abbreviated, time: .shortened))
            } else {
                Text("Not downloaded yet.").foregroundStyle(.secondary)
            }
            if let problem = roads.problem { Text(problem).font(.caption).foregroundStyle(.orange) }
            Button(roads.updating ? "Updating…" : "Update Now") { roads.refresh(api: model.api, force: true) }
                .disabled(roads.updating)
        } header: {
            Text("Road data on this iPhone")
        } footer: {
            Text("Finds the highway post mile for a location without a connection. Checked daily; new versions download on Wi-Fi.")
        }
    }
}
