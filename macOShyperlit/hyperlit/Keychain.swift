//
//  Keychain.swift
//  hyperlit
//
//  Tiny generic-password Keychain wrapper. API keys are stored here (encrypted
//  by macOS), keyed by provider id. The web layer can never read a value back —
//  only the native `ai.fetch` path injects it into the Authorization header.
//

import Foundation
import Security

enum Keychain {
    private static let service = "app.hyperlit.ai"

    private static func base(_ ref: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: ref,
        ]
    }

    /// Store (or replace) the key for `ref`.
    static func set(_ ref: String, _ value: String) {
        var q = base(ref)
        SecItemDelete(q as CFDictionary)               // replace semantics
        q[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(q as CFDictionary, nil)
    }

    /// Read the key for `ref`, or nil.
    static func get(_ ref: String) -> String? {
        var q = base(ref)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func exists(_ ref: String) -> Bool { get(ref) != nil }

    static func delete(_ ref: String) {
        SecItemDelete(base(ref) as CFDictionary)
    }
}
