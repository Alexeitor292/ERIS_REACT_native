// swift-tools-version:5.9
// Platform-neutral core of the ERIS iOS app: models, the API client, sign-in
// orchestration and the role/notification rules. No UIKit, Security or MSAL
// here, so its tests also run on Linux in CI.
import PackageDescription

let package = Package(
    name: "ERISKit",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "ERISKit", targets: ["ERISKit"]),
    ],
    targets: [
        .target(name: "ERISKit"),
        .testTarget(name: "ERISKitTests", dependencies: ["ERISKit"]),
    ]
)
