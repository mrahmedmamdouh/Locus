// swift-tools-version:5.9
// Locus iOS SDK. Add it in Xcode with File → Add Package Dependencies… → https://github.com/mrahmedmamdouh/Locus
import PackageDescription

let package = Package(
    name: "Locus",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "LocusSDK", targets: ["LocusSDK"]),
        .library(name: "LocusCore", targets: ["LocusCore"]),
    ],
    targets: [
        .target(name: "LocusCore", path: "sdk/ios/Sources/LocusCore"),
        .target(name: "LocusSDK", dependencies: ["LocusCore"], path: "sdk/ios/Sources/LocusSDK", resources: [.copy("PrivacyInfo.xcprivacy")]),
        .testTarget(name: "LocusCoreTests", dependencies: ["LocusCore"], path: "sdk/ios/Tests/LocusCoreTests"),
        .testTarget(name: "LocusSDKTests", dependencies: ["LocusSDK"], path: "sdk/ios/Tests/LocusSDKTests"),
    ]
)
