// JarvisConfigTests.swift — sanity coverage for the config seam.

import XCTest
@testable import Jarvis

final class JarvisConfigTests: XCTestCase {

    func test_defaultServerURL_isAValidURL() {
        XCTAssertNotNil(URL(string: JarvisConfig.defaultServerURLString))
    }

    func test_healthURL_swapsSchemeAndPath() throws {
        let ws = URL(string: "ws://example.com:3000/realtime")!
        let health = JarvisConfig.healthURL(from: ws)
        XCTAssertEqual(health?.absoluteString, "http://example.com:3000/healthz")

        let wss = URL(string: "wss://api.example.com/realtime")!
        let healthSecure = JarvisConfig.healthURL(from: wss)
        XCTAssertEqual(healthSecure?.absoluteString, "https://api.example.com/healthz")
    }

    func test_userDefaultsAugmentation_roundTripsServerURL() {
        let defaults = UserDefaults(suiteName: "JarvisConfigTests.\(UUID().uuidString)")!
        let next = URL(string: "wss://jarvis-deploy.example.com/realtime")!
        defaults.jarvisServerURL = next
        XCTAssertEqual(defaults.jarvisServerURL, next)

        defaults.clearJarvisServerURLOverride()
        XCTAssertEqual(defaults.jarvisServerURL.absoluteString, JarvisConfig.defaultServerURLString)
    }
}
