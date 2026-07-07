//
//  ProviderStore.swift
//  hyperlit
//
//  The native-owned AI provider configuration. Profile metadata persists in
//  UserDefaults; API keys live in the Keychain (never here). This is the single
//  source of truth the bridge serves to the web layer via `providers.snapshot`.
//

import Foundation
import Combine

struct Provider: Codable, Identifiable, Hashable {
    var id: String
    var label: String
    var kind: String        // "llm" | "tts"
    var baseUrl: String
    var model: String
    var voice: String?      // TTS only
}

final class ProviderStore: ObservableObject {
    @Published var providers: [Provider] = []
    @Published var activeLlm: String?
    @Published var activeTts: String?

    /// Set by the WebView; fires a `providers_changed` event to the web layer.
    var onChanged: (() -> Void)?

    private let kProviders = "hyperlit.providers.v1"
    private let kActiveLlm = "hyperlit.active.llm"
    private let kActiveTts = "hyperlit.active.tts"

    init() { load() }

    func provider(id: String) -> Provider? { providers.first { $0.id == id } }

    /// The payload the bridge returns for `providers.snapshot`. `hasKey` is
    /// derived from the Keychain; no key values are ever included.
    func snapshot() -> [String: Any] {
        [
            "profiles": providers.map { p -> [String: Any] in
                [
                    "id": p.id,
                    "label": p.label,
                    "kind": p.kind,
                    "baseUrl": p.baseUrl,
                    "model": p.model,
                    "voice": p.voice as Any,
                    "hasKey": Keychain.exists(p.id),
                ]
            },
            "activeLlm": activeLlm as Any,
            "activeTts": activeTts as Any,
        ]
    }

    // ── Mutations (each persists + notifies) ─────────────────────────────────

    func upsert(_ p: Provider) {
        if let i = providers.firstIndex(where: { $0.id == p.id }) { providers[i] = p }
        else { providers.append(p) }
        persist()
    }

    func remove(_ p: Provider) {
        providers.removeAll { $0.id == p.id }
        Keychain.delete(p.id)
        if activeLlm == p.id { activeLlm = nil }
        if activeTts == p.id { activeTts = nil }
        persist()
    }

    /// Toggle a profile as the active one for its kind (click active again ⇒ off).
    func toggleActive(_ p: Provider) {
        if p.kind == "llm" { activeLlm = (activeLlm == p.id) ? nil : p.id }
        else { activeTts = (activeTts == p.id) ? nil : p.id }
        persist()
    }

    func setKey(_ p: Provider, _ value: String) {
        Keychain.set(p.id, value)
        persist()   // hasKey changed → snapshot changed
    }

    func clearKey(_ p: Provider) {
        Keychain.delete(p.id)
        persist()
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    private func persist() {
        let defaults = UserDefaults.standard
        defaults.set(try? JSONEncoder().encode(providers), forKey: kProviders)
        defaults.set(activeLlm, forKey: kActiveLlm)
        defaults.set(activeTts, forKey: kActiveTts)
        onChanged?()
    }

    private func load() {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: kProviders),
           let decoded = try? JSONDecoder().decode([Provider].self, from: data) {
            providers = decoded
        }
        activeLlm = defaults.string(forKey: kActiveLlm)
        activeTts = defaults.string(forKey: kActiveTts)
    }
}
