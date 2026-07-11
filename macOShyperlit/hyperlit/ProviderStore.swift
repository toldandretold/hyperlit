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
    var kind: String        // "llm" | "tts" | "ocr"
    var baseUrl: String
    var model: String
    var voice: String?      // TTS only
}

final class ProviderStore: ObservableObject {
    @Published var providers: [Provider] = []
    @Published var activeLlm: String?
    @Published var activeTts: String?
    @Published var activeOcr: String?

    /// Set by the WebView; fires a `providers_changed` event to the web layer.
    var onChanged: (() -> Void)?

    private let kProviders = "hyperlit.providers.v1"
    private let kActiveLlm = "hyperlit.active.llm"
    private let kActiveTts = "hyperlit.active.tts"
    private let kActiveOcr = "hyperlit.active.ocr"

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
            "activeOcr": activeOcr as Any,
        ]
    }

    /// The active OCR provider, if one is selected — the ocr.run bridge method
    /// uses it (the user's own Mistral key, or a local/hosted vision model)
    /// instead of the on-device engine. No key required: local VLM endpoints
    /// (Ollama, LM Studio) are keyless.
    func activeOcrProvider() -> Provider? {
        guard let id = activeOcr, let p = provider(id: id), !p.baseUrl.isEmpty else { return nil }
        return p
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
        if activeOcr == p.id { activeOcr = nil }
        persist()
    }

    /// Toggle a profile as the active one for its kind (click active again ⇒ off).
    func toggleActive(_ p: Provider) {
        switch p.kind {
        case "llm": activeLlm = (activeLlm == p.id) ? nil : p.id
        case "ocr": activeOcr = (activeOcr == p.id) ? nil : p.id
        default: activeTts = (activeTts == p.id) ? nil : p.id
        }
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
        defaults.set(activeOcr, forKey: kActiveOcr)
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
        activeOcr = defaults.string(forKey: kActiveOcr)
    }
}
