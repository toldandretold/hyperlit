//
//  Bridge.swift
//  hyperlit
//
//  The native side of the JS↔Swift bridge (protocol v1, see the web repo's
//  docs/native-bridge-protocol.md). Receives requests posted to the "native"
//  message handler and replies via window.__hyperlitNativeReply(...).
//
//  Methods handled here: ping, providers.snapshot, ai.fetch. (secret.* is
//  unnecessary — the native Settings UI writes Keychain directly; file.* arrives
//  with the local-audio phase.)
//

import WebKit

final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    let store: ProviderStore

    init(store: ProviderStore) {
        self.store = store
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
        default:
            reply(id, ok: false, code: "unsupported_method", message: method)
        }
    }

    /// Push a native-initiated event (no id) to the web layer.
    func fireProvidersChanged() {
        evaluate("window.__hyperlitNativeReply({v:1,event:'providers_changed',data:{}})")
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
