//
//  AISettingsView.swift
//  hyperlit
//
//  The native AI settings (⌘,). Add LLM / TTS providers, store keys in Keychain,
//  pick which is active, and test the connection. This is the ONLY place AI
//  providers are configured — the web reader has no such UI.
//

import SwiftUI

// Presets: one click to a sensible base URL + model. Local runtimes (Ollama /
// LM Studio) speak the OpenAI shape, so they need no special handling.
struct Preset { let label: String; let baseUrl: String; let model: String; let voice: String? }

private let kLlmPresets: [Preset] = [
    Preset(label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", voice: nil),
    Preset(label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/deepseek-v3", voice: nil),
    Preset(label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", voice: nil),
    Preset(label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", model: "llama3.1", voice: nil),
    Preset(label: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", model: "local-model", voice: nil),
    Preset(label: "Custom", baseUrl: "", model: "", voice: nil),
]

private let kTtsPresets: [Preset] = [
    Preset(label: "DeepInfra · Kokoro-82M", baseUrl: "https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M", model: "hexgrad/Kokoro-82M", voice: "af_bella"),
    Preset(label: "Custom", baseUrl: "", model: "", voice: ""),
]

// PDF OCR: without a provider, PDFs are OCR'd on-device (Apple Vision/PDFKit,
// free — fast, but geometric heuristics only). Activating a provider routes
// ocr.run through a model that READS the page: Mistral's OCR API (your key),
// or a local vision model via Ollama / LM Studio (free, slower, needs a
// vision-capable model pulled — e.g. `ollama pull qwen2.5vl`).
private let kOcrPresets: [Preset] = [
    Preset(label: "Mistral OCR", baseUrl: "https://api.mistral.ai", model: "mistral-ocr-latest", voice: nil),
    Preset(label: "Ollama vision (local)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5vl", voice: nil),
    Preset(label: "LM Studio vision (local)", baseUrl: "http://localhost:1234/v1", model: "local-model", voice: nil),
    Preset(label: "Custom (OpenAI-compatible)", baseUrl: "", model: "", voice: nil),
]

struct AISettingsView: View {
    @ObservedObject var store: ProviderStore

    var body: some View {
        TabView {
            ProviderListView(store: store, kind: "llm", presets: kLlmPresets)
                .tabItem { Text("LLM") }
            ProviderListView(store: store, kind: "tts", presets: kTtsPresets)
                .tabItem { Text("Voice (TTS)") }
            ProviderListView(store: store, kind: "ocr", presets: kOcrPresets)
                .tabItem { Text("PDF OCR") }
        }
        .frame(width: 540, height: 480)
        .padding()
    }
}

struct ProviderListView: View {
    @ObservedObject var store: ProviderStore
    let kind: String
    let presets: [Preset]

    private var items: [Provider] { store.providers.filter { $0.kind == kind } }
    private var activeId: String? {
        switch kind {
        case "llm": return store.activeLlm
        case "ocr": return store.activeOcr
        default: return store.activeTts
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Keys are stored only on this Mac (Keychain) and never sent to Hyperlit's servers.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if kind == "ocr" {
                Text("Without a provider here, PDFs are OCR'd on this Mac for free (Apple Vision — fast, best for clean digital PDFs). For scanned books, activate a model that reads the page: Mistral OCR (your key, billed by Mistral) or a local vision model via Ollama/LM Studio (free, slower — pull a vision model like qwen2.5vl first).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            List {
                ForEach(items) { p in
                    ProviderRow(store: store, provider: p, isActive: activeId == p.id)
                }
                if items.isEmpty {
                    Text("No providers yet.").foregroundStyle(.secondary)
                }
            }

            Menu("Add provider") {
                ForEach(presets.indices, id: \.self) { i in
                    Button(presets[i].label) { add(from: presets[i]) }
                }
            }
            .frame(width: 160)
        }
    }

    private func add(from preset: Preset) {
        let id = "\(kind)_\(Int(Date().timeIntervalSince1970))"
        store.upsert(Provider(
            id: id,
            label: preset.label == "Custom" ? "New provider" : preset.label,
            kind: kind,
            baseUrl: preset.baseUrl,
            model: preset.model,
            voice: kind == "tts" ? (preset.voice ?? "af_bella") : nil
        ))
    }
}

struct ProviderRow: View {
    @ObservedObject var store: ProviderStore
    let provider: Provider
    let isActive: Bool

    @State private var draft: Provider
    @State private var keyInput: String = ""
    @State private var status: String = ""

    init(store: ProviderStore, provider: Provider, isActive: Bool) {
        self.store = store
        self.provider = provider
        self.isActive = isActive
        _draft = State(initialValue: provider)
    }

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                labeled("Label", text: $draft.label)
                labeled("Base URL", text: $draft.baseUrl)
                labeled("Model", text: $draft.model)
                if draft.kind == "tts" {
                    labeled("Voice", text: Binding(
                        get: { draft.voice ?? "" },
                        set: { draft.voice = $0 }
                    ))
                }
                SecureField(
                    Keychain.exists(provider.id) ? "Key stored ✓ — type to replace" : "API key (optional for local)",
                    text: $keyInput
                )

                HStack {
                    Button("Save") {
                        store.upsert(draft)
                        if !keyInput.isEmpty { store.setKey(draft, keyInput); keyInput = "" }
                        status = "Saved"
                    }
                    Button(isActive ? "Active ✓" : "Use") { store.toggleActive(draft) }
                    Button("Test") { runTest() }
                    Spacer()
                    Button(role: .destructive) { store.remove(provider) } label: {
                        Image(systemName: "trash")
                    }
                }
                if !status.isEmpty {
                    Text(status).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        } label: {
            HStack {
                Text(provider.label).bold()
                if isActive { Text("active").font(.caption).foregroundStyle(.green) }
                if Keychain.exists(provider.id) { Image(systemName: "key.fill").font(.caption2).foregroundStyle(.secondary) }
            }
        }
    }

    private func labeled(_ title: String, text: Binding<String>) -> some View {
        HStack {
            Text(title).frame(width: 70, alignment: .leading).foregroundStyle(.secondary)
            TextField(title, text: text).textFieldStyle(.roundedBorder)
        }
    }

    /// Minimal reachability check: LLM → GET /models; OCR (Mistral) → GET
    /// /v1/models; TTS → a tiny synth.
    private func runTest() {
        status = "Testing…"
        let p = draft
        guard !p.baseUrl.isEmpty else { status = "Enter a base URL first"; return }
        // Save first so a just-pasted key is available to the test.
        store.upsert(p)
        if !keyInput.isEmpty { store.setKey(p, keyInput); keyInput = "" }

        Task {
            let isLlm = p.kind == "llm"
            let isOcr = p.kind == "ocr"
            let path = isLlm ? "/models" : (isOcr ? "/v1/models" : "")
            guard let url = URL(string: p.baseUrl + path) else {
                await MainActor.run { status = "Invalid URL" }; return
            }
            var r = URLRequest(url: url)
            r.httpMethod = (isLlm || isOcr) ? "GET" : "POST"
            if let key = Keychain.get(p.id), !key.isEmpty {
                r.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            }
            if !isLlm && !isOcr {
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = try? JSONSerialization.data(withJSONObject: [
                    "text": "test", "preset_voice": [p.voice ?? "af_bella"], "output_format": "mp3",
                ])
            }
            do {
                let (_, resp) = try await URLSession.shared.data(for: r)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                await MainActor.run {
                    status = (200..<300).contains(code) ? "OK — reachable (\(code))" : "Failed — HTTP \(code)"
                }
            } catch {
                await MainActor.run { status = "Error — \(error.localizedDescription)" }
            }
        }
    }
}
