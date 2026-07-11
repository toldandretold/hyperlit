# Hyperlit for macOS

A native macOS shell around the Hyperlit web app, built for one idea: **bring your own AI**. The web reader runs inside a `WKWebView`; the native side holds your API keys in the macOS Keychain and does the AI work the server would otherwise charge for — LLM calls, TTS, and (the big one) PDF OCR, which runs entirely on your Mac using Apple's built-in text recognition. Your keys never leave the native layer, and none of them are ever sent to Hyperlit's servers.

## What the app does

- **Hosts the reader** — `ContentView.swift` loads the Hyperlit front end (`kSiteURL`: `https://hyperlit.test` for local dev, switch to `https://hyperlit.xyz` for a shippable build) and injects `window.__hyperlitNative = true` so the web layer knows it's inside the shell.
- **Owns AI provider config** — the Settings window (⌘,, `AISettingsView.swift`) manages LLM / TTS / PDF-OCR providers. Profile metadata lives in UserDefaults (`ProviderStore.swift`); keys live only in the Keychain (`Keychain.swift`). The web layer can see *that* a key exists, never the key itself.
- **Bridges JS ↔ Swift** — `Bridge.swift` implements the message protocol (`ping`, `providers.snapshot`, `ai.fetch`, `ocr.*`). The contract is documented in the repo's `docs/native-bridge-protocol.md` — that file is the source of truth for both sides.
- **OCRs PDFs on-device** — `PdfOcr/` converts a PDF to the same JSON Mistral's paid OCR API returns, so importing a PDF through the app costs nothing. The web import flow detects the shell, runs the local OCR, and uploads the result with the PDF; the server pipeline replays from it without calling Mistral.

## The on-device PDF OCR engine (`hyperlit/PdfOcr/`)

The engine's output contract is Mistral's `ocr_response.json` (reference shape: `tests/conversion/fixtures/pdf/*/synthetic/ocr_response.json` in the repo). Per page it emits markdown (with `#` headings, `[^N]` footnote refs, `[^N]: …` / `N. …` definitions), running header/footer text split into their own fields, and embedded figures as base64 JPEGs.

- **`PdfOcrEngine.swift`** — orchestrator: analyze every page, compute document stats, compose markdown, extract images.
- **`PageAnalyzer.swift`** — text-layer extraction via PDFKit: font runs (size + bold) with page-space geometry, grouped into visual lines. Pages with a missing or garbage text layer (scans, mojibake fonts) are flagged for Vision.
- **`VisionPageOcr.swift`** — scanned-page path: renders the page at ~300dpi and runs `VNRecognizeTextRequest`; observations feed the same composer with box-height as the font-size proxy. Any page that is physically a scan (a full-page image XObject) goes through Vision regardless of its text layer — a scan's text layer is a previous OCR pass of unknown quality. Low-confidence observations are dropped (chart noise, script hallucinations), heading thresholds are stricter here (the box-height proxy is ±20% noisy), and chart/table pages (text dominated by numeric fragments) ship as a page image plus caption instead of fake prose.
- **`DocumentStats.swift`** — cross-page pass: body font size, modal line spacing, and running header/footer detection (top/bottom band lines whose normalized text repeats across pages, plus bare page numbers).
- **`MarkdownComposer.swift`** — the heuristics: headings by font-size ratio, superscript footnote markers (small raised digit runs → `[^N]`, conservative on purpose — the server pipeline resurrects bare numbers with sequential validation, but a *wrong* `[^N]` can mislead it), page-bottom footnote blocks, paragraph joining with hyphenation repair, and two-column reading order (spanning lines emit in place; narrow segments split left-then-right).
- **`ImageExtractor.swift`** — embedded figures: a CGPDF content-stream scan finds where image XObjects are placed; the page is rendered once and each placement rect cropped to JPEG (`img-p{page}-{k}.jpeg`, referenced as `![id](id)` in the markdown).
- **`MistralOcrClient.swift`** — BYO-key mode: when a Mistral OCR provider is active in Settings, `ocr.run` calls Mistral's API with the user's key instead of the on-device engine (highest quality, billed to the user by Mistral directly). PDFs ≤ 8MB go inline as base64; larger ones upload + signed URL; over 50MB falls back to on-device.
- **`OcrBridgeHandler.swift`** — the `ocr.*` bridge sessions: chunked PDF upload (4MB envelope cap → 2MB raw chunks), background engine run with throttled `ocr_progress` events, chunked result download, cancellation and session GC.

## The command-line tool (`hyperlit-ocr`)

The same engine builds as a standalone CLI so a Mac-hosted Hyperlit backend (Herd local dev) can OCR PDFs for free without the app in the loop:

```
./build-cli.sh                       # → bin/hyperlit-ocr (needs full Xcode, not just CLT)
bin/hyperlit-ocr <pdf> <out.json> [--progress] [--no-images]
```

Point the Laravel backend at it in `.env` (`NATIVE_OCR_BINARY=/path/to/bin/hyperlit-ocr`, `OCR_PROVIDER=auto`); `PdfProcessor.php` then produces the OCR cache locally and skips Mistral. `--progress` prints `PROGRESS:{…}` lines in the pipeline's `emit_progress` format so the import UI shows live page counts. The CLI also doubles as a fixture/debug generator — run it on any PDF and inspect the JSON.

## Building the app

- Open `hyperlit.xcodeproj` in Xcode (deployment target macOS 15.7; the project uses a filesystem-synchronized group, so new files under `hyperlit/` are picked up automatically — no pbxproj editing).
- The app is sandboxed (network client/server, user-selected files read-write). OCR temp files live under the container's `Application Support/ocr/`.
- For a local-dev build against `hyperlit.test`, keep `kSiteURL` as is; for production, point it at `https://hyperlit.xyz`.
- `webView.isInspectable = true` — attach Safari's Web Inspector (Develop menu) to see the web layer's console, including the bridge traffic.

## Manually verifying the OCR path

1. Run the local backend (Herd) and the app with `kSiteURL = https://hyperlit.test`.
2. Import a PDF through the app's normal import form — the cost estimate should read "Free — processed on this Mac", and the submit button should tick through "OCR page x/y…".
3. Compare against a Mistral baseline of the same PDF if you have one: the `Footnotes:` / `Headings:` counts `mistral_ocr.py` prints, `footnote_meta.json`'s classification, `media/` file count, and node counts in the reader.
4. `laravel.log` should show `Using cached OCR response` and no `MISTRAL_OCR_API_KEY` error even with the key unset.
5. Server-side CLI path: unset `MISTRAL_OCR_API_KEY`, set `NATIVE_OCR_BINARY`, import through any browser on `hyperlit.test` — conversion runs with no API call and a zero-amount `ocr_charged.json`.

## Security invariants

- Keys are written only by the native Settings UI, read only by native code (`ai.fetch`, `MistralOcrClient`), and never appear in any bridge reply.
- The server never trusts client OCR provenance: it re-stamps the `model` field (`hyperlit-native-ocr` / `hyperlit-client-mistral-ocr`) and writes the zero-charge marker itself, so a client can only skip paying for OCR work the server also didn't do.
- Client-supplied OCR JSON is schema-validated server-side (`ValidationService::parseOcrResponseFile`), image filenames are constrained against path traversal, and image bytes are re-validated before serving.
