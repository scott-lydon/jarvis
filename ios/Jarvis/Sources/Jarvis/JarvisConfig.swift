// JarvisConfig.swift
//
// Runtime configuration for the iOS client. The server URL is read from
// UserDefaults (key `jarvis.serverURL`) so an operator can flip between
// local dev and the Render deploy without rebuilding the app. The userId
// is stored in Keychain so it survives app reinstalls and lets the
// server's per-user memory row keep working.
//
// Why type-augmentation (per the user's style preference): the helpers
// hang off `UserDefaults` and `Keychain` as extensions instead of a
// JarvisConfigService class. The call sites read like:
//   `UserDefaults.standard.jarvisServerURL`
//   `Keychain.jarvisUserId`
// which is where a Swift developer would intuitively look for them.

import Foundation
import Security

public enum JarvisConfig {
    /// Default server when nothing has been overridden in UserDefaults.
    /// Production builds should ship pointing at the Render deploy; dev
    /// builds default to the local server scheme on `localhost:3000`.
    /// Both schemes (`ws://` and `wss://`) are accepted; the WebSocket
    /// open path is `/realtime`.
    public static let defaultServerURLString = "ws://127.0.0.1:3000/realtime"

    /// Where on the server the health endpoint lives. Used by the iOS
    /// client to query live capabilities for the "what can you do?"
    /// surface without speaking.
    public static func healthURL(from serverURL: URL) -> URL? {
        guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else { return nil }
        // The WS URL ends in /realtime; healthz lives at /healthz on the
        // same host, swap path + scheme.
        components.path = "/healthz"
        switch components.scheme {
        case "ws":  components.scheme = "http"
        case "wss": components.scheme = "https"
        default:    break
        }
        return components.url
    }
}

// MARK: - UserDefaults augmentation

extension UserDefaults {
    private static let serverURLKey = "jarvis.serverURL"

    /// The currently configured server URL. Falls back to the bundle
    /// default if the user has not overridden it. Setting `nil` removes
    /// the override.
    public var jarvisServerURL: URL {
        get {
            if let raw = string(forKey: Self.serverURLKey),
               let url = URL(string: raw) {
                return url
            }
            // Force-unwrapping the default is safe: it's a compile-time
            // literal in this module and is validated by Tests/JarvisTests.
            return URL(string: JarvisConfig.defaultServerURLString)!
        }
        set {
            set(newValue.absoluteString, forKey: Self.serverURLKey)
        }
    }

    public func clearJarvisServerURLOverride() {
        removeObject(forKey: Self.serverURLKey)
    }
}

// MARK: - Keychain augmentation (userId persistence)

/// Tiny Keychain helper. Stored as a generic-password item under the
/// service `com.frontieraudio.jarvis` so a single account row holds the
/// userId. We persist the userId for cross-session memory recall (US-03).
public enum Keychain {
    private static let service = "com.frontieraudio.jarvis"
    private static let account = "user.id"

    /// Fetches the stored userId, or mints + stores a new UUID v4 if one
    /// isn't already present. The mint-on-miss behavior matches the web
    /// client's localStorage path so iOS and web users get separate
    /// stable identities on the same device family.
    public static var jarvisUserId: String {
        if let existing = read() { return existing }
        let new = UUID().uuidString.lowercased()
        write(new)
        return new
    }

    /// Replace the stored userId. Mostly useful for tests and for the
    /// "Reset memory" button in the debug screen.
    public static func setJarvisUserId(_ id: String) {
        write(id)
    }

    private static func read() -> String? {
        var query: [String: Any] = [
            kSecClass as String:            kSecClassGenericPassword,
            kSecAttrService as String:      service,
            kSecAttrAccount as String:      account,
            kSecReturnData as String:       true,
            kSecMatchLimit as String:       kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data, let str = String(data: data, encoding: .utf8) else {
            return nil
        }
        _ = query.removeValue(forKey: kSecReturnData as String)
        return str
    }

    private static func write(_ value: String) {
        let data = Data(value.utf8)
        // Idempotent upsert: delete-then-add. Returns silently if the
        // delete found nothing — that's the "first time" case.
        let baseQuery: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
        ]
        SecItemDelete(baseQuery as CFDictionary)
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
