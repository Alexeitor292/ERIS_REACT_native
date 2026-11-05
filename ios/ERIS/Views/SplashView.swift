import SwiftUI

/// The opening animation of ERIS, as in the Expo app and the website: the logo
/// shrinks into place from six times its size on navy, "ERIS" fades in under it,
/// and the whole screen fades away onto the app. It never takes a tap.
struct SplashView: View {
    /// The demo skips it, so tests start on the app, unless asked (`-ERISDemoSplash YES`).
    static var shouldPlay: Bool {
        #if DEBUG
        if DemoMode.isOn { return UserDefaults.standard.bool(forKey: "ERISDemoSplash") }
        #endif
        return true
    }

    let done: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scale: CGFloat = 6
    @State private var nameOpacity = 0.0
    @State private var opacity = 1.0

    var body: some View {
        ZStack {
            Color(red: 0.016, green: 0.075, blue: 0.176).ignoresSafeArea()
            VStack(spacing: 12) {
                Image("ErisSplash")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 210, height: 210)
                    .scaleEffect(scale)
                    .accessibilityHidden(true)
                Text("ERIS")
                    .font(.system(size: 30, weight: .heavy))
                    .tracking(2.4)
                    .foregroundStyle(.white)
                    .opacity(nameOpacity)
                    .accessibilityIdentifier("eris-splash")
            }
            .dynamicTypeSize(.large)
        }
        .opacity(opacity)
        .allowsHitTesting(false)
        .task {
            if reduceMotion {
                scale = 1
                nameOpacity = 1
            } else {
                withAnimation(.easeOut(duration: 0.9)) { scale = 1 }
                withAnimation(.easeOut(duration: 0.42).delay(0.46)) { nameOpacity = 1 }
            }
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 500 : 1750))
            withAnimation(.easeOut(duration: 0.26)) { opacity = 0 }
            try? await Task.sleep(for: .milliseconds(260))
            done()
        }
    }
}
