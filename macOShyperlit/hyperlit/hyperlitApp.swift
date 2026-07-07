//
//  hyperlitApp.swift
//  hyperlit
//
//  App entry. Owns the ProviderStore (the native-owned AI provider config) and
//  exposes it both to the reader window (so the bridge can answer the web layer)
//  and to the Settings window (⌘,) where the user manages providers + keys.
//

import SwiftUI

@main
struct hyperlitApp: App {
    @StateObject private var store = ProviderStore()

    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
        }

        // ⌘, opens this. All AI-provider / API-key UI lives HERE, natively —
        // never in the web reader.
        Settings {
            AISettingsView(store: store)
        }
    }
}
