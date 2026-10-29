import ERISKit
import Foundation
import Observation

/// This copy of a technical form, as the others in it see it: a heartbeat
/// every few seconds (and at once when it starts writing a memo) saying which
/// memos it is writing, so those are locked for everyone else; in return, who
/// else is here, which memos they hold, and the form's saved revision. It lives
/// as long as the form screen does, and says goodbye when that closes.
@MainActor @Observable
final class FormPresenceSession {
    private(set) var reply: PresenceReply?
    /// The memos this person is writing (changed and not yet saved).
    var writing: [String] = [] {
        didSet { if Set(writing) != Set(oldValue) { beatSoon() } }
    }

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let submissionId: Int
    @ObservationIgnored private let session = UUID().uuidString.lowercased()
    @ObservationIgnored private var typing = false
    @ObservationIgnored private var inFlight = false

    init(api: APIClient, submissionId: Int) {
        self.api = api
        self.submissionId = submissionId
        let (session, id) = (session, submissionId)
        Task { [weak self] in
            while true {
                do {
                    guard let self else { break }
                    await self.beat()
                }
                try? await Task.sleep(for: .seconds(5))
            }
            // The form closed.
            try? await SubmissionsAPI(api: api).leavePresence(id, session: session)
        }
    }

    /// Others in the form, once each.
    var others: [PresenceOther] { reply?.others ?? [] }

    /// Memo key -> the person writing it (read-only here meanwhile).
    var writers: [String: PresenceOther] { Presence.writers(others) }

    /// Keeps the memo locks alive while this person types.
    func typed() { typing = true }

    func beatSoon() {
        Task { await beat() }
    }

    private func beat() async {
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }
        let wasTyping = typing
        typing = false
        // Presence is a courtesy; the saves themselves refuse what would overwrite someone.
        if let next = try? await SubmissionsAPI(api: api).presence(submissionId, session: session, area: nil, field: nil,
                                                                   memos: writing, typing: wasTyping) {
            reply = next
        }
    }
}
