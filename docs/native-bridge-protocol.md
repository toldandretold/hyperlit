# Native bridge protocol (v1)

The contract between the Hyperlit web front end (running inside a `WKWebView`) and the native macOS shell (Swift). The web side is `resources/js/utilities/nativeBridge.ts`; the Swift side is a `WKScriptMessageHandler` you implement in Xcode. **Both ends must agree on the envelopes below.** This document is the source of truth — if you change an envelope, bump `NATIVE_PROTOCOL_VERSION` in `nativeBridge.ts` and the Swift `version` together.

## Transport

The shell injects, via a `WKUserScript` at document start (`forMainFrameOnly`, runs before any page JS):

```js
window.__hyperlitNative = true;
```

That flag is how the front end knows it is inside the shell (`isNativeShell()`). In a plain browser it is absent, every `nativeCall` rejects with `unsupported_method`, and the app falls back to its normal server behaviour.

Two channels:

- **JS → native**: `window.webkit.messageHandlers.native.postMessage(jsonString)` — the front end posts a JSON **string** (already serialized; Swift decodes it). The handler name is `native`.
- **native → JS**: `window.__hyperlitNativeReply(object)` — Swift calls this one global function (via `evaluateJavaScript`, on the main thread) with a JS object (not a string). It carries both correlated replies and unsolicited events.

## Envelopes

All envelopes carry `v: 1`.

### Request (JS → native)

```json
{ "v": 1, "id": "nb_1a", "method": "ai.fetch", "payload": { } }
```

`id` is an opaque correlation string. `method` is one of the methods below. `payload` is method-specific.

### Reply (native → JS) — has `id`

Success:

```json
{ "v": 1, "id": "nb_1a", "ok": true, "result": { } }
```

Failure:

```json
{ "v": 1, "id": "nb_1a", "ok": false, "error": { "code": "not_allowed_host", "message": "…" } }
```

The front end matches `id` to the pending call, resolves with `result` or rejects with a `NativeBridgeError(code, message)`. A reply whose `id` is unknown (the call already timed out) is silently ignored.

### Event (native → JS) — no `id`

```json
{ "v": 1, "event": "some_event", "data": { } }
```

Delivered to every handler registered via `onNativeEvent("some_event", …)`. (Currently the inference round-trip is driven server-side over SSE, so events are reserved for future native-initiated pushes — keep the channel implemented.)

## Error codes

| code | meaning |
|---|---|
| `timeout` | native did not reply within the call's `timeoutMs` (raised JS-side; native need not send it) |
| `denied` | user declined a native permission prompt |
| `not_allowed_host` | `ai.fetch` URL resolved outside the profile's registered base URL / allowlist |
| `network` | native's outbound HTTP failed (DNS, TLS, connection) |
| `keychain` | Keychain read/write/delete failed |
| `unsupported_method` | unknown `method`, or not running in the shell |
| `payload_too_large` | serialized payload exceeded 4 MB |
| `internal` | anything else |

## Size & time limits

- **Max payload**: 4 MB (`MAX_PAYLOAD_BYTES`). The front end rejects `payload_too_large` before posting; Swift should enforce the same cap defensively.
- **Timeouts** are owned by the JS caller (each `nativeCall` sets its own; default 30 s). LLM calls pass up to 300 s, TTS up to 120 s. Native should not block forever — honour any `timeoutMs` in the payload where it makes a downstream request, but the authoritative timeout is JS-side.

## Ownership: native owns the AI provider config

**The native app owns the entire AI-provider configuration** — the provider list, the active LLM/TTS selections, the API keys (Keychain), the presets, and the "Test connection" UI all live in the **native macOS Settings window** (Swift), NOT in the web reader. Regular website users have no AI-provider UI. The web layer only *reads* the config (to route inference) and *executes* inference (`ai.fetch`). Keys never enter JS in either direction.

When the user edits settings, native pushes a `providers_changed` **event** (no `id`); the web side drops its cached snapshot and re-reads on next use.

## Method namespace (v1)

| method | payload | result | notes |
|---|---|---|---|
| `ping` | `{}` | `{ version }` | health check |
| `providers.snapshot` | `{}` | `{ profiles: [{ id, label, kind, baseUrl, model, voice?, hasKey }], activeLlm, activeTts }` | native returns its current config. `activeLlm`/`activeTts` are profile ids or null. `hasKey` reflects Keychain. **No key values are ever included.** |
| `ai.fetch` | `{ profileId, path, method, bodyJson?, timeoutMs? }` | `{ status, bodyJson? , bodyText? }` | native builds the URL as `profile.baseUrl + path`, rejects `not_allowed_host` if it escapes the base, injects `Authorization: Bearer <keychain[profileId]>` from Keychain, and makes the HTTPS request. **The key never crosses into JS.** |
| `file.writeAudio` | `{ book, filename, base64 }` | `{ ok: true, bytes }` | write an MP3 to the app's per-book audio dir |
| `file.readManifest` | `{ book }` | `{ json \| null }` | read the local audio manifest for a book |
| `file.writeManifest` | `{ book, json }` | `{ ok: true }` | write the local audio manifest |
| `file.deleteAudio` | `{ book, filenames? }` | `{ ok: true }` | delete some/all local audio for a book |
| `file.audioUrl` | `{ book, filename }` | `{ url }` | a `hyperlit-local://audio/<book>/<filename>` URL served by the shell's `WKURLSchemeHandler` (with Range support) |

### Events (native → JS, no `id`)

| event | data | meaning |
|---|---|---|
| `providers_changed` | `{}` | the user edited AI settings; web should re-read `providers.snapshot` |

### Security invariants

1. **Keys never enter JS.** There is no method that returns a key value. Keychain is written only by the native Settings UI; native alone injects the `Authorization` header inside `ai.fetch`. A compromised page script cannot exfiltrate a stored key.
2. **Host allowlist.** `ai.fetch` may only hit a URL under the `baseUrl` of a profile native currently holds (matched by `profileId`). Anything else → `not_allowed_host`.
3. **Path traversal.** `file.*` methods must reject `book`/`filename` values that escape the app's audio directory; constrain to a safe charset (e.g. `[A-Za-z0-9_-]` plus a single `.mp3` suffix on filenames).

## Swift Coordinator sketch (informative)

```swift
// config.userContentController.add(coordinator, name: "native")
func userContentController(_ ucc: WKUserContentController, didReceive msg: WKScriptMessage) {
    guard let str = msg.body as? String,
          let data = str.data(using: .utf8),
          let req = try? JSONDecoder().decode(Request.self, from: data) else { return }
    Task {
        let reply = await handle(req)          // returns {v,id,ok,result|error}
        let json = String(data: try! JSONEncoder().encode(reply), encoding: .utf8)!
        await MainActor.run {
            webView.evaluateJavaScript("window.__hyperlitNativeReply(\(json))")
        }
    }
}
```
