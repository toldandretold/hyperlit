//
//  Bridge.swift
//  hyperlit
//
//  The native side of the JS↔Swift bridge (protocol v1, see the web repo's
//  docs/native-bridge-protocol.md). Receives requests posted to the "native"
//  message handler and replies via window.__hyperlitNativeReply(...).
//
//  Methods handled here: ping, providers.snapshot, ai.fetch, and the ocr.*
//  family (on-device PDF OCR — sessions live in OcrBridgeHandler). (secret.* is
//  unnecessary — the native Settings UI writes Keychain directly; file.* arrives
//  with the local-audio phase.)
//

import WebKit

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    let store: ProviderStore
    let ocr = OcrBridgeHandler()

    init(store: ProviderStore) {
        self.store = store
        super.init()
        ocr.emitEvent = { [weak self] event, data in
            self?.fireEvent(event, data: data)
        }
        // BYO OCR (the user's own Mistral key, or a local/hosted vision model):
        // resolved per run from the active "ocr"-kind provider. The key — when
        // one exists; local VLMs are keyless — is read from Keychain here and
        // handed only to native code, never into JS.
        ocr.byoOcrProvider = { [weak self] in
            guard let p = self?.store.activeOcrProvider() else { return nil }
            return (baseUrl: p.baseUrl, model: p.model, apiKey: Keychain.get(p.id) ?? "")
        }
    }

    // WebKit delivers this on the main thread.
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let raw = message.body as? String,
              let data = raw.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = req["id"] as? String,
              let method = req["method"] as? String else { return }
        let payload = req["payload"] as? [String: Any] ?? [:]

        switch method {
        case "ping":
            reply(id, ok: true, result: ["version": 1])
        case "providers.snapshot":
            reply(id, ok: true, result: store.snapshot())
        case "ai.fetch":
            Task { await aiFetch(id: id, payload: payload) }
        case "ocr.begin", "ocr.chunk", "ocr.run", "ocr.result", "ocr.end", "ocr.cancel":
            ocrCall(id: id, method: method, payload: payload)
        case "file.writeAudio", "file.readManifest", "file.writeManifest", "file.deleteAudio", "file.audioUrl":
            fileCall(id: id, method: method, payload: payload)
        default:
            reply(id, ok: false, code: "unsupported_method", message: method)
        }
    }

    // ── file.*: local audio store (BYO TTS — MP3s on this Mac) ────────────────

    private func fileCall(id: String, method: String, payload: [String: Any]) {
        guard let book = payload["book"] as? String else {
            reply(id, ok: false, code: "internal", message: "missing book"); return
        }
        do {
            switch method {
            case "file.writeAudio":
                guard let filename = payload["filename"] as? String,
                      let base64 = payload["base64"] as? String else {
                    reply(id, ok: false, code: "internal", message: "missing filename/base64"); return
                }
                let bytes = try AudioStore.writeAudio(book: book, filename: filename, base64: base64)
                reply(id, ok: true, result: ["ok": true, "bytes": bytes])
            case "file.readManifest":
                reply(id, ok: true, result: ["json": try AudioStore.readManifest(book: book) as Any])
            case "file.writeManifest":
                guard let json = payload["json"] else {
                    reply(id, ok: false, code: "internal", message: "missing json"); return
                }
                try AudioStore.writeManifest(book: book, json: json)
                reply(id, ok: true, result: ["ok": true])
            case "file.deleteAudio":
                try AudioStore.deleteAudio(book: book, filenames: payload["filenames"] as? [String])
                reply(id, ok: true, result: ["ok": true])
            default: // file.audioUrl
                guard let filename = payload["filename"] as? String else {
                    reply(id, ok: false, code: "internal", message: "missing filename"); return
                }
                try AudioStore.validateBook(book)
                try AudioStore.validateFilename(filename)
                reply(id, ok: true, result: ["url": "\(LocalAudioSchemeHandler.scheme)://audio/\(book)/\(filename)"])
            }
        } catch {
            reply(id, ok: false, code: "denied", message: error.localizedDescription)
        }
    }

    /// Push a native-initiated event (no id) to the web layer.
    func fireProvidersChanged() {
        evaluate("window.__hyperlitNativeReply({v:1,event:'providers_changed',data:{}})")
    }

    /// Push an arbitrary event envelope (no id) to the web layer.
    func fireEvent(_ event: String, data: [String: Any]) {
        guard let payload = try? JSONSerialization.data(withJSONObject: ["v": 1, "event": event, "data": data]),
              let json = String(data: payload, encoding: .utf8) else { return }
        evaluate("window.__hyperlitNativeReply(\(json))")
    }

    // ── ocr.*: on-device PDF OCR (sessions + engine in OcrBridgeHandler) ──────

    private func ocrCall(id: String, method: String, payload: [String: Any]) {
        do {
            let result: [String: Any]
            switch method {
            case "ocr.begin": result = try ocr.begin(payload: payload)
            case "ocr.chunk": result = try ocr.chunk(payload: payload)
            case "ocr.run": result = try ocr.run(payload: payload)
            case "ocr.result": result = try ocr.result(payload: payload)
            default: result = try ocr.end(payload: payload)   // ocr.end / ocr.cancel
            }
            reply(id, ok: true, result: result)
        } catch let error as OcrBridgeError {
            reply(id, ok: false, code: error.code, message: error.message)
        } catch {
            reply(id, ok: false, code: "ocr_failed", message: error.localizedDescription)
        }
    }

    // ── ai.fetch: native makes the HTTPS call, injecting the Keychain key ─────

    private func aiFetch(id: String, payload: [String: Any]) async {
        guard let pid = payload["profileId"] as? String,
              let profile = store.provider(id: pid) else {
            reply(id, ok: false, code: "not_allowed_host", message: "unknown profile"); return
        }
        let path = payload["path"] as? String ?? ""
        // The URL must resolve under the profile's registered base URL.
        guard let url = URL(string: profile.baseUrl + path),
              url.absoluteString.hasPrefix(profile.baseUrl), !profile.baseUrl.isEmpty else {
            reply(id, ok: false, code: "not_allowed_host", message: "url escapes base"); return
        }

        var request = URLRequest(url: url)
        request.httpMethod = (payload["method"] as? String) ?? "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key = Keychain.get(pid), !key.isEmpty {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        if let body = payload["bodyJson"], !(body is NSNull) {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        if let ms = payload["timeoutMs"] as? Double { request.timeoutInterval = ms / 1000.0 }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            var result: [String: Any] = ["status": status]
            if let json = try? JSONSerialization.jsonObject(with: data) {
                result["bodyJson"] = json
            }
            result["bodyText"] = String(data: data, encoding: .utf8) ?? ""
            reply(id, ok: true, result: result)
        } catch {
            reply(id, ok: false, code: "network", message: error.localizedDescription)
        }
    }

    // ── Reply plumbing ────────────────────────────────────────────────────────

    private func reply(_ id: String, ok: Bool, result: [String: Any] = [:], code: String = "", message: String = "") {
        var env: [String: Any] = ["v": 1, "id": id, "ok": ok]
        if ok {
            env["result"] = result
        } else {
            env["error"] = ["code": code, "message": message]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: env),
              let json = String(data: data, encoding: .utf8) else { return }
        evaluate("window.__hyperlitNativeReply(\(json))")
    }

    private func evaluate(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js)
        }
    }
}
