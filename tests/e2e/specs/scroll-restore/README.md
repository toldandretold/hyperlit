# scroll-restore suite

Forensics-driven tests for the mobile "return to the book and it shakes" glitch class. Every spec imports a synthetic image-bearing book (~340 nodes, 4 lazy chunks, an unsized PNG every 3 paragraphs), saves a deep reading position at a marker paragraph, then returns via a different route and asserts two things:

1. **Landed right** — the marker paragraph ends within tolerance of its setup-time viewport position.
2. **No shake** — after the boot overlay hides, the reader's scroll position converges without oscillating (bounded direction reversals and a settle time cap).

## Running

```bash
npm run test:e2e -- specs/scroll-restore                      # desktop chromium (all 6 specs)
npm run test:e2e -- --project=scroll-restore-mobile           # phone emulation (390×844 + touch)
npx playwright test -c playwright.webkit.config.js specs/scroll-restore   # webkit
```

Needs `npm run dev:all` (the default-queue worker converts imports) and an authed `.auth-state.json` (the `setup` project creates it). e2e is manual-only, never CI.

## The matrix

- `fresh-resume.spec.js` — full fresh document loads: text-only control, images-instant, images-held-past-first-paint (the phone cold-cache case).
- `reload.spec.js` — `page.reload()` in the same three modes, plus a Slow-3G arm (CDP `Network.emulateNetworkConditions`, Chromium-only).
- `bfcache.spec.js` — (A) CDP `Page.setWebLifecycleState` freeze/thaw (Chromium-only): zero scroll-writes after `resume`, pixel-exact. (B) Real traversal `goto('/')` → `goBack()`: whichever branch the browser actually takes (frozen vs fresh load) is asserted against its contract and annotated on the result as `bfcache-branch` — so a green run that never hit the frozen path is visible.
- `spa-backforward.spec.js` — real-gesture SPA home → back, three landings with media held, ending in a rapid forward/back burst.
- `refresh-storm.spec.js` — routes `…/books/{id}/library` and bumps `timestamp` on the real response so `checkAndUpdateIfNeeded` deterministically fires `lazyLoader.refresh()` seconds after restore. Asserts the position converges in ONE episode — the reproduction harness for the "fine, then shakes seconds later" report.
- `prepend-compensation.spec.js` — media held, scroll up one viewport to force `loadPreviousChunkFixed`, then release; asserts the marker does not slide when the prepended chunk's images decode (the under-measured-height hypothesis).

## Forensics plumbing

- `helpers/scrollForensics.js` — init-script recorder: rAF-samples `.reader-content-wrapper` scrollTop + overlay visibility + one tracked node's viewport rect; logs `pageshow`/`pagehide` (with `persisted`), `freeze`/`resume`, `visibilitychange`. Enables the app's own `hyperlit_scroll_trace` so every app scroll-write lands in `window.__scrollTrace` with a reason + stack. `analyzeSettle()` turns the samples into `{overlayHiddenAt, writesPostHide, reversals, settleMs, peakTrackExcursionPx}`. Failures auto-attach `scroll-forensics.json` to the Playwright report.
- `helpers/mediaThrottle.js` — `throttleImages(page, {pattern, mode, serve})`: `instant | delay | hold | stall`, every fulfill no-store. For `https://img.test/**` (the default unsized arm) a `serve(url)` map supplies the bytes since the host doesn't exist. `emulateSlowNetwork()` wraps CDP network conditions (Chromium-only).
- `helpers/pngGen.js` — minimal hand-rolled PNG encoder: few-KB solid-stripe PNGs declaring 1400×900, so decode is cheap but layout shift is maximal.
- `scenario.js` (this folder) — `setupImageBookScenario(page, spa, {imageMode})`: `'remote'` (img.test, unsized — default, the atrocious case), `'media'` (real `/{book}/media/` images via the md+files vault drop, dims may be stamped), `'none'` (control).

## Gotchas

- `test.use({ serviceWorkers: 'block' })` across the folder: the app SW would hide image requests from route interception; known trade-off is that SW-mediated timing differences are NOT covered here (see resources/js/scrolling/README.md warning).
- Held = "never fulfills until `release()`". Specs must `throttle.unroute()` in teardown (it releases pending holds) or the test can wedge.
- Unsized-vs-sized matters: `remote` mode guarantees no width/height attributes. If you switch arms to `media`, verify the stamps — a sized image reserves its aspect-ratio box and silently turns the arm into a no-op.
- WebKit: CDP arms auto-skip (`browserName` guards); the real-traversal bfcache arm and everything else run.

## Current status (2026-08-25 — first runs)

9 green, 1 skip, **2 RED reproductions** (deterministic, 3/3 runs):

- **refresh-storm.spec.js** — second scroll episode at t≈+5.4s after the overlay hid: restore lands 0→8520, user sees settled content, then `lazyLoader.refresh()` (armed by a newer server timestamp) tears down every chunk and re-scrolls into a torn DOM, landing scrollTop=0. Forensics: marker excursion 11097px. This is the "looks fine, then shakes, ends up at the top" report, on demand.
- **prepend-compensation.spec.js** — images decoding into already-rendered chunks above the viewport slide content with no compensation: top-visible node changed identity, tracked-marker excursion 5600px, settle ~9s after release. The "atrocious with images" report, on demand. (The spec's scroll-up prepend didn't add a chunk — the plain image-settle slide above the viewport is what's captured; still the same fix surface: above-viewport growth is uncompensated.)

Fix pass (next): gate `refresh()` behind not-yet-shown content (loadHyperText.ts:241) or make it non-destructive around a settled position; add above-viewport image-settle compensation (belt exists only inside `scrollHelpers`' navigation window).

Dumps on failure: `test-results/scroll-forensics/<test>.json` (wiped each run, like the console-audit dir).

## Slotting in the real book

When a real image-heavy book export is available: `php artisan book:import <bundle.tar>` in the harness, or extend `scenario.js` with a `bookId` passthrough that skips generation and just does the scroll/save/track steps against the existing book. Keep the synthetic arms — the real book is a scenario, not a replacement (its byte sizes and timings aren't controllable).
