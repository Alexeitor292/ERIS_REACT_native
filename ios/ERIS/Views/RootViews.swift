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
            MainTabView(me: me)
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

struct MainTabView: View {
    @EnvironmentObject private var model: AppModel
    let me: Me
    @State private var tab = Tab.incidents
    @State private var incidentPath: [Int] = []

    enum Tab: Hashable {
        case incidents, assessments, submissions, notifications, account
    }

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $incidentPath) { IncidentsView(me: me) }
                .tabItem { Label("Incidents", systemImage: "exclamationmark.triangle") }
                .tag(Tab.incidents)
            if AssessmentTab.isVisible(to: me.roles) {
                NavigationStack { AssessmentsView(me: me) }
                    .tabItem { Label("Assessments", systemImage: "checkmark.seal") }
                    .tag(Tab.assessments)
            }
            NavigationStack { SubmissionsView() }
                .tabItem { Label("Submissions", systemImage: "doc.text") }
                .tag(Tab.submissions)
            NavigationStack { NotificationsView() }
                .tabItem { Label("Notifications", systemImage: "bell") }
                .badge(NotificationRoutes.badgeText(model.unread) ?? "")
                .tag(Tab.notifications)
            NavigationStack { AccountView(me: me) }
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(Tab.account)
        }
        .onChange(of: model.pendingRoute) { _, route in
            // A tapped notification opens its incident. Other screens arrive
            // in later phases of the port; until then the feed stays open.
            switch route {
            case .incident(let id):
                model.pendingRoute = nil
                tab = .incidents
                incidentPath = [id]
            case .submission:
                model.pendingRoute = nil
                tab = .submissions
            case .assessments where AssessmentTab.isVisible(to: me.roles):
                model.pendingRoute = nil
                tab = .assessments
            default:
                return
            }
        }
    }
}

struct AccountView: View {
    @EnvironmentObject private var model: AppModel
    let me: Me

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
            Section {
                Button("Sign out", role: .destructive) {
                    Task { await model.signOut() }
                }
            } footer: {
                Text("Signs this iPhone out of ERIS. Your other devices stay signed in.")
            }
        }
        .navigationTitle("Account")
    }
}
