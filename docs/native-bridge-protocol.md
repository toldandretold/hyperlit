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

- **`timeout`** — native did not reply within the call's `timeoutMs` (raised JS-side; native need not send it).
- **`denied`** — user declined a native permission prompt.
- **`not_allowed_host`** — `ai.fetch` URL resolved outside the profile's registered base URL / allowlist.
- **`network`** — native's outbound HTTP failed (DNS, TLS, connection).
- **`keychain`** — Keychain read/write/delete failed.
- **`unsupported_method`** — unknown `method`, or not running in the shell.
- **`payload_too_large`** — serialized payload exceeded 4 MB.
- **`ocr_failed`** — the on-device (or BYO-provider) PDF OCR engine failed; the message carries the engine's reason.
- **`internal`** — anything else.

## Size & time limits

- **Max payload**: 4 MB (`MAX_PAYLOAD_BYTES`). The front end rejects `payload_too_large` before posting; Swift should enforce the same cap defensively.
- **Timeouts** are owned by the JS caller (each `nativeCall` sets its own; default 30 s). LLM calls pass up to 300 s, TTS up to 120 s. Native should not block forever — honour any `timeoutMs` in the payload where it makes a downstream request, but the authoritative timeout is JS-side.

## Ownership: native owns the AI provider config

**The native app owns the entire AI-provider configuration** — the provider list, the active LLM/TTS selections, the API keys (Keychain), the presets, and the "Test connection" UI all live in the **native macOS Settings window** (Swift), NOT in the web reader. Regular website users have no AI-provider UI. The web layer only *reads* the config (to route inference) and *executes* inference (`ai.fetch`). Keys never enter JS in either direction.

When the user edits settings, native pushes a `providers_changed` **event** (no `id`); the web side drops its cached snapshot and re-reads on next use.

## Method namespace (v1)

- **`ping`** — payload `{}` → `{ version }`. Health check.
- **`providers.snapshot`** — payload `{}` → `{ profiles: [{ id, label, kind, baseUrl, model, voice?, hasKey }], activeLlm, activeTts, activeOcr }`. Native returns its current config. `kind` is `llm` | `tts` | `ocr`; the `active*` fields are profile ids or null. `hasKey` reflects Keychain. **No key values are ever included.**
- **`ai.fetch`** — payload `{ profileId, path, method, bodyJson?, timeoutMs? }` → `{ status, bodyJson?, bodyText? }`. Native builds the URL as `profile.baseUrl + path`, rejects `not_allowed_host` if it escapes the base, injects `Authorization: Bearer <keychain[profileId]>` from Keychain, and makes the HTTPS request. **The key never crosses into JS.**
- **`file.writeAudio`** — payload `{ book, filename, base64 }` → `{ ok: true, bytes }`. Write an MP3 to the app's per-book audio dir.
- **`file.readManifest`** — payload `{ book }` → `{ json | null }`. Read the local audio manifest for a book.
- **`file.writeManifest`** — payload `{ book, json }` → `{ ok: true }`. Write the local audio manifest.
- **`file.deleteAudio`** — payload `{ book, filenames? }` → `{ ok: true }`. Delete some/all local audio for a book.
- **`file.audioUrl`** — payload `{ book, filename }` → `{ url }`. A `hyperlit-local://audio/<book>/<filename>` URL served by the shell's `WKURLSchemeHandler` (with Range support).

### `ocr.*` — on-device PDF OCR

The shell OCRs PDFs locally (PDFKit text layer + Apple Vision fallback; `hyperlit/PdfOcr/` in the Xcode project) and returns a JSON byte-compatible with Mistral's `ocr_response.json`, which the web layer attaches to the `/import-file` upload (field `ocr_response`, plus `ocr_source`) so the server conversion pipeline replays from it — no Mistral call, no charge. When the user activates a BYO OCR provider in Settings, `ocr.run` routes there instead of the on-device engine: Mistral's OCR API (detected by base URL/model), or any OpenAI-compatible vision model — Ollama / LM Studio locally, or a hosted endpoint — which transcribes each rendered page to markdown. Keys (when any; local VLMs are keyless) stay native-side.

The 4MB envelope cap means the PDF arrives and the result leaves in chunks. `chunkSize` (returned by `ocr.begin`) is the RAW byte slice per chunk — 2MB raw ≈ 2.7MB base64, under the cap in both directions.

- **`ocr.begin`** — payload `{ bytesTotal, name? }` → `{ sessionId, chunkSize }`. Opens a session (temp file in the sandbox container). Sessions are garbage-collected after 30 minutes.
- **`ocr.chunk`** — payload `{ sessionId, seq, dataBase64 }` → `{ receivedBytes }`. Sequential upload of the PDF bytes; out-of-order or over-declared chunks are rejected.
- **`ocr.run`** — payload `{ sessionId }` → `{ accepted: true }`. Starts the engine on a background task once all declared bytes arrived. Completion arrives as an `ocr_complete` event.
- **`ocr.result`** — payload `{ sessionId, seq }` → `{ dataBase64, last }`. Pull the result JSON back chunk by chunk after `ocr_complete`.
- **`ocr.end` / `ocr.cancel`** — payload `{ sessionId }` → `{ ok: true }`. Cancels any live run and deletes the session + temp file. Always call this (the JS client does so in a `finally`).

### Events (native → JS, no `id`)

- **`providers_changed`** — data `{}`. The user edited AI settings; web should re-read `providers.snapshot`.
- **`ocr_progress`** — data `{ sessionId, page, totalPages, stage }`. Engine progress, throttled to ~4/s. `stage` is `text` | `vision` | `images` | `compose`, or `mistral` while a BYO remote provider is in flight (then `page`/`totalPages` are 0 — keepalive pulses for the JS stall watchdog).
- **`ocr_complete`** — data `{ sessionId, ok, pages?, resultBytes?, chunkCount?, source?, error? }`. Terminal event for `ocr.run`; `source` is `native` | `mistral` (the web layer forwards it as the upload's `ocr_source`).

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
