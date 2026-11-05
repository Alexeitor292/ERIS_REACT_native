import ERISKit
import Foundation
// MSAL predates Swift concurrency; its completion handlers run on the main queue.
@preconcurrency import MSAL
import UIKit

/// Entra access tokens for the ERIS API scope through MSAL. MSAL signs in
/// through Microsoft Authenticator (the broker), so the device's Caltrans
/// sign-in, MFA, device compliance and the Enterprise SSO plug-in all apply.
/// There is no client secret: ERIS Mobile is a public client.
final class MSALTokenProvider: EntraTokenProvider, @unchecked Sendable {
    private var application: MSALPublicClientApplication?
    private var applicationKey: String?

    private func client(for config: EntraMobileConfig) throws -> MSALPublicClientApplication {
        let key = "\(config.authority)|\(config.clientId)"
        if let application, applicationKey == key { return application }
        guard let url = URL(string: config.authority) else { throw AuthError.untrustedAuthority }
        let authority = try MSALAADAuthority(url: url)
        // redirectUri nil = msauth.<bundle id>://auth, as registered for ERIS Mobile.
        let configuration = MSALPublicClientApplicationConfig(clientId: config.clientId, redirectUri: nil,
                                                              authority: authority)
        let created = try MSALPublicClientApplication(configuration: configuration)
        application = created
        applicationKey = key
        return created
    }

    func acquireTokenInteractively(_ config: EntraMobileConfig) async throws -> String {
        let application = try client(for: config)
        let presenter = try await MainActor.run { () throws -> UIViewController in
            guard let top = UIApplication.shared.topViewController else { throw AuthError.cancelled }
            return top
        }
        let parameters = await MainActor.run {
            MSALInteractiveTokenParameters(scopes: config.scopes,
                                           webviewParameters: MSALWebviewParameters(authPresentationViewController: presenter))
        }
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.main.async {
                application.acquireToken(with: parameters) { result, error in
                    if let result {
                        continuation.resume(returning: result.accessToken)
                    } else {
                        continuation.resume(throwing: Self.translate(error))
                    }
                }
            }
        }
    }

    func acquireTokenSilently(_ config: EntraMobileConfig) async throws -> String {
        let application = try client(for: config)
        guard let account = try application.allAccounts().first else { throw AuthError.interactionRequired }
        let parameters = MSALSilentTokenParameters(scopes: config.scopes, account: account)
        return try await withCheckedThrowingContinuation { continuation in
            application.acquireTokenSilent(with: parameters) { result, error in
                if let result {
                    continuation.resume(returning: result.accessToken)
                } else {
                    continuation.resume(throwing: Self.translate(error))
                }
            }
        }
    }

    private static func translate(_ error: Error?) -> Error {
        guard let error = error as NSError? else { return AuthError.cancelled }
        if error.domain == MSALErrorDomain {
            if error.code == MSALError.interactionRequired.rawValue { return AuthError.interactionRequired }
            if error.code == MSALError.userCanceled.rawValue { return AuthError.cancelled }
        }
        return error
    }
}

extension UIApplication {
    /// The view controller MSAL presents its sign-in from.
    var topViewController: UIViewController? {
        let window = connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
