//
//  ContentView.swift
//  hyperlit
//
//  The reader window: a WKWebView hosting the Hyperlit web front end, wired to
//  the native bridge (Bridge.swift) so the web layer can reach native powers.
//

import SwiftUI
import WebKit

// Change to https://hyperlit.xyz (prod) for a shippable build; hyperlit.test is
// the local Herd dev server.
private let kSiteURL = URL(string: "https://hyperlit.test")!

struct ContentView: View {
    let store: ProviderStore

    var body: some View {
        WebView(url: kSiteURL, store: store)
            .frame(minWidth: 1000, minHeight: 700)
    }
}

struct WebView: NSViewRepresentable {
    let url: URL
    let store: ProviderStore

    func makeCoordinator() -> Bridge { Bridge(store: store) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // hyperlit-local:// — streams locally generated audio (BYO TTS) from
        // disk with Range support. Must be registered before the view exists.
        config.setURLSchemeHandler(LocalAudioSchemeHandler(), forURLScheme: LocalAudioSchemeHandler.scheme)

        // Tell the web front end it's inside the native shell (before any page JS).
        let flag = WKUserScript(
            source: "window.__hyperlitNative = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(flag)

        // JS → Swift channel: window.webkit.messageHandlers.native.postMessage(...)
        config.userContentController.add(context.coordinator, name: "native")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true   // Safari → Develop can attach a console
        context.coordinator.webView = webView

        // When the user edits AI settings, push a `providers_changed` event so the
        // web layer re-reads its snapshot.
        store.onChanged = { [weak coordinator = context.coordinator] in
            coordinator?.fireProvidersChanged()
        }

        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
