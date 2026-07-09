# `resources/js/scrolling` — the reading-position & scroll-navigation framework

This folder owns the **READ side** of scroll: *where should the viewport be, and who decides?* The **WRITE side** — the lazy loader that renders chunks and detects "which node is on top" — lives in `resources/js/lazyLoader`. Every per-file docstring explains its own module; this README is the layer above that: the **strategy** (what the system is trying to do), the **decision tree** (what wins when signals conflict), and the **invariants** (rules you must not break). Read this before touching any scroll behaviour — the bugs here are almost always "two correct-looking mechanisms fought and the wrong one won."

## The one-sentence mental model

There is exactly **one** notion of "the reader's position" (a single node id + sub-node pixel offset), it is **written** by one detector in the lazy loader, **read** through one accessor (`readingAnchor.ts`), and **acted on** by one navigation engine (`internalNav.ts`). Everything else in this folder exists to decide *when* those fire and to stop them fighting the user.

## The three jobs

The whole folder is three verbs over that single position:

- **SAVE** — *record where the reader currently is.* Owned by the **write side** (`lazyLoader` `forceSavePosition`/`saveScrollPosition` → `scrollPosition_<bookId>` storage, plus `readingPosition.ts` for the server bookmark).
- **RESTORE** — *on page load, put them back (or honour a deep link).* **This folder** — `restore.ts` `restoreScrollPosition()`.
- **NAVIGATE** — *on a click / hash / programmatic jump, go to a specific id.* **This folder** — `internalNav.ts` `navigateToInternalId()`.

SAVE and NAVIGATE both ultimately call the same low-level mechanic (`scrollHelpers.ts` `scrollElementWithConsistentMethod`). RESTORE is a *router*: it decides *what* to navigate to, then delegates to NAVIGATE (or loads chunk 0 if there's no target).

## The single source of position

- **Detector** (write): the lazy loader's `forceSavePosition` finds the topmost visible node and writes `{ elementId, offset, chunk_id }` to `scrollPosition_<bookId>` in `sessionStorage` (this tab, live) + `localStorage` (survives fresh tabs), **throttled to 250 ms**. It also debounces a **5 s** server save and a `sendBeacon` on unload via `readingPosition.ts` (cross-device resume). There is exactly ONE detector — it handles chunked node tags, the straddling-node case, and the container-relative top edge. **Never write a second "which node is visible" detector.**
- **Accessor** (read): `readingAnchor.ts` is the ONLY sanctioned way to read that value.
  - `getSavedAnchor(bookId)` — the last saved value. **Lags reality by up to 250 ms.** Use for *restore-flavoured* reads ("where were they last?").
  - `getFreshAnchor(bookId)` — re-runs the detector **synchronously** first, so it's exact. Use when *acting on the current position* (start audio here, open search here, place the caret here, bookmark here).
- **The lag is a bug magnet.** Reading the raw storage and assuming it's "now" is what made the audio player start books from the top (a stale/absent anchor fell through to "top"). Guardrail `tests/javascript/architecture/scrollPositionAccessor.test.js` fails any file outside the allowlist that touches `scrollPosition_*` storage directly.

## The RESTORE decision tree (page load / `restoreScrollPosition`)

This is the highest-stakes logic — it's where "deep link vs resume vs refresh" is resolved.

```
restoreScrollPosition()
│
├─ normalise ?scroll=… query param → URL #hash   (Word-doc links avoid #→%23)
│
├─ BAIL if any of:
│    • content doesn't overflow AND no #hash
│    • user is actively scrolling            (userScrollDetection)
│    • search toolbar open / blocking        (don't fight search UX)
│    • global skip flag set                  (operationState — a hash/book-to-book nav owns navigation)
│    • no currentLazyLoader yet              (mid book-to-book transition — yield quietly, NOT an error)
│    • already navigating to an internal id
│    • URL path is /HL_… or /Fn…             (BookToBookTransition handles it)
│
├─ pick a TARGET, in priority order:
│    1. URL #hash  ──unless── "already navigated" (see Refresh rule below)
│    2. saved position (session → local storage)   [only if no explicit hash target]
│    3. nothing → load chunk 0 (or lowest chunk; preserve bfcache DOM if present)
│
└─ navigateToInternalId(target, offset)
        • hash target      → offset = 192 (header)
        • position resume  → offset = saved sub-node pixel offset (land on the exact pixel)
```

### The refresh-vs-back/forward rule (the subtle one)

A `#hypercite_…` / `#HL_…` / `#<numeric>` hash in the URL means "a deep link was followed." The question is: **on the NEXT page load, do we re-jump to that hash, or resume where the reader actually scrolled to?** Two signals disambiguate, and the golden rule is **the hash is NEVER stripped from the URL** (stripping via `replaceState` corrupts the history entry, so back/forward would lose the target — that's the "lands at the top" class):

- `navigatedHashes` (`navState.ts`) — an in-memory `Set`, **wiped on reload**. "We already jumped to this hash this session."
- `hasScrolledAwayFromHash` (`navState.ts`, sessionStorage) — **survives a same-tab refresh**. Written by `clearStaleHash.ts` when the user scrolls away from an internal-nav hash (but not while a container is open).

How each entry event resolves:
- **Refresh** (no popstate fires) — `navigatedHashes` is wiped (empty) but `scrolledAway` persists, so the surviving signal says "already seen this hash" → **resume the reading position**.
- **Back/forward** (popstate fires) — `LinkNavigationHandler._handlePopstateInner` **clears both** signals for the current hash → **the hash wins, jump to it**.
- **Fresh deep-link open** — both signals empty → the hash is a genuine explicit target → **jump to it**.

## The NAVIGATE engine (`internalNav.ts` `navigateToInternalId`)

The "scroll to a specific id" workhorse. It's Promise-based (resolves when scroll truly completes — an iOS Safari race fix) and does a lot to survive lazy loading:

1. **Lock** scroll + set `isNavigatingToInternalId` (so RESTORE yields); a real user wheel/touch/key **aborts** the nav and unlocks immediately (never trap the user).
2. **Already-rendered fast path** — `findRenderedTarget` (handles hypercite overlapping segments): if the node is in the DOM, scroll straight to it, no flash.
3. Else **resolve** which chunk holds it (`resolveTargetChunkId`, queries IndexedDB stores). Soft-target guard: a citation-ref id that doesn't resolve against *this* book is a foreign target (the marker lives in the citing book) → bail quietly, no 5 s spin. Unresolved + not-fully-loaded → wait for the background download, retry.
4. **Load** the target chunk (+ neighbours) — fast-path fills neighbours without clearing; slow-path clears and rebuilds.
5. `waitForNavigationTarget` → **FINAL SCROLL**: measure visibility; if not already well-placed, `scrollElementWithConsistentMethod`.
6. Post-scroll flourishes: hypercite glow (`hypercites/animations`), highlight container open (`HL_`), footnote arrow-pulse (`Fn`).

The **landing offset** is `192` px (clears the sticky header) for deep links, or the saved sub-node offset for a position resume.

## The low-level mechanic (`scrollHelpers.ts`)

`scrollElementWithConsistentMethod(el, container, offset=192)` is the actual scroll. It computes the target from a stable `offsetTop` walk (not `getBoundingClientRect`, which shifts as content loads), scrolls instant, then schedules **corrections**: one at 100 ms (fonts/layout settle) and one per still-loading image *above* the target (images change the height above the target and would otherwise leave it mis-positioned).

⚠️ **The correction is a known footgun.** It re-measures the node the closure captured. If a re-render (chunk reload, coalesced popstate) **detaches** that node in the correction window, its `offsetTop` collapses to `0` and the "correction" scrolls to the TOP, clobbering a good scroll — this was the cross-book-forward "lands at the top, not the hypercite" bug (regression test: `tests/e2e/specs/regression/cross-book-forward-anchor.spec.js`). Guard: `correctScrollPosition` re-resolves the id against the live DOM and **bails if the node is detached / not laid out** (`offsetParent === null`) rather than scroll to a bogus `0`.

## The "don't fight the user" guards (`userScrollDetection.ts` + `navState.ts`)

Restoration and navigation must yield to manual input. Two time windows and one flag:

- `isUserCurrentlyScrolling()` — true during a scroll and for **2 s** after (restoration checks this).
- `isActivelyScrollingForLinkBlock()` — much tighter, **200 ms** (so "scroll → stop → click" works).
- `userScrollState.isNavigating` — set while WE scroll, so navigation scrolls aren't misread as user scrolls (`resetUserScrollState()` clears it on book change).

`shouldSkipScrollRestoration()` (this folder) = "is the user scrolling?"; the **global** `shouldSkipScrollRestoration` in `utilities/operationState.ts` is a *different* flag = "a hash/book-to-book nav is driving; restoration stand down." `BookToBookTransition` sets the global one before init; `restore.ts` checks it early and clears it.

## The 192 px invariant

The header offset **192** appears in three places and they must stay in sync:
- `scrollHelpers.ts` `headerOffset` default (where nav lands a target).
- `.reader-content-wrapper { scroll-padding-top: 192px }` in CSS (fragment-nav alignment).
- `selectionAutoScroll.ts` zeroes that `scroll-padding-top` **during a drag-select**, because the browser's native selection auto-scroll treats the padding band as a scroll-into-view zone and races the reader upward (see the `selectionAutoScroll.ts` docstring for the measured mechanism). It restores it on pointer-up.

## Module map

Each module, its role, and its key exports:

- **`index.ts`** — barrel, the folder's public surface. Exports: the re-exports below + `clearNavigatedHashes()`.
- **`restore.ts`** — the **RESTORE router**; page-load entry, the decision tree above. Exports: `restoreScrollPosition()`.
- **`internalNav.ts`** — the **NAVIGATE engine**; scroll to an id through lazy loading. Exports: `navigateToInternalId()`, `resetUserScrollState` (re-export).
- **`scrollHelpers.ts`** — the low-level scroll mechanic + correction. Exports: `scrollElementWithConsistentMethod`, `scrollElementIntoMainContent`, `isValidContentElement`.
- **`readingAnchor.ts`** — **THE accessor** for the saved position (fresh vs saved). Exports: `getSavedAnchor`, `getFreshAnchor`.
- **`readingPosition.ts`** — the server-persisted bookmark (cross-device resume). Exports: `debouncedServerSave`, `sendBeaconSave`.
- **`navState.ts`** — zero-import leaf holding shared mutable state. Exports: `userScrollState`, `navigatedHashes`, `hasScrolledAwayFromHash`, `navTimers`.
- **`userScrollDetection.ts`** — the "is the user scrolling?" guards. Exports: `isUserCurrentlyScrolling`, `shouldSkipScrollRestoration`, `setupUserScrollDetection`.
- **`clearStaleHash.ts`** — marks "scrolled away" so a refresh resumes instead of re-jumping. Exports: `markInternalNavHashScrolledAway`.
- **`navOverlay.ts`** — legacy wrappers over `ProgressOverlayConductor`. Exports: `showNavigationLoading`, `hideNavigationLoading`.
- **`selectionAutoScroll.ts`** — stops the upward race during a drag-select. Exports: `initSelectionAutoScroll`, `isSelectionDragActive`.
- **`wheelScrollForwarder.ts`** — forwards the wheel from dead zones (header / side margins). Exports: `initWheelScrollForwarder`.
- **`scrollTrace.ts`** — the **dormant diagnostic**; records every scroll write. Exports: `installScrollTrace`, `recordScrollWrite`, `recordNavDecision`.

## Collaborators outside this folder

- `lazyLoader/index.ts` — the **write side**: renders chunks, owns the topmost-node detector (`forceSavePosition`), holds `scrollableParent` (`.reader-content-wrapper`), installs `scrollTrace`.
- `SPA/navigation/pathways/BookToBookTransition.ts` — cross-book nav; sets the global skip flag, then calls `handleHashNavigation` → `navigateToInternalId`.
- `SPA/navigation/LinkNavigationHandler.ts` `_handlePopstateInner` — back/forward; **clears `navigatedHashes` + `scrolledAway`** so the hash wins on popstate (the refresh-vs-back/forward rule).
- `hyperlitContainer/history.ts` `restoreContainerStack` — when a history entry has an open container (`?cs=N`), IT scrolls the main reader to the anchor (a *different* path from `internalNav`).
- `utilities/operationState.ts` — the global `skipScrollRestoration` flag.

## Diagnosing "who scrolled?" (`scrollTrace.ts`)

When a scroll goes wrong, don't parse stacks by hand. Enable the tracer:
1. `localStorage.setItem('hyperlit_scroll_trace','true')` then **reload** (install is gated at reader-init for zero prod cost).
2. Reproduce, then `window.__scrollTrace.dump()` — every programmatic write to the reader scroller with a trimmed stack + a semantic `reason` tag (`consistent-scroll`, `scroll-correction`, …), interleaved with popstate nav-decisions.

This is how the detached-node correction bug was caught: two writes, `newTop=1027` (connected) then `newTop=0` (detached). **e2e note:** browser `console.log`s only reach the test's stdout if the spec wires `page.on('console', …)`, and `serviceWorkers: 'block'` shifts fetch timing enough to MASK the re-render race — reproduce with the SW active.

## Invariants (break these and you get a scroll bug)

1. **One detector.** Never write a second "which node is visible" scan — extend `forceSavePosition`.
2. **One accessor.** Read position only via `readingAnchor.ts`; `getFreshAnchor` when acting on *now*.
3. **Never strip the hash** from the URL to suppress a re-jump — mark `scrolledAway` instead.
4. **Never scroll off a detached/unmeasured node.** Re-resolve by id or bail; a computed `0` from a dead node is not a real target.
5. **Yield to the user.** Check the scroll guards before any restoration; abort nav on real user input.
6. **Keep 192 in sync** across `scrollHelpers`, the `scroll-padding-top` CSS, and `selectionAutoScroll`.
7. **Import posture:** `navState.ts` is a zero-import leaf (TDZ-safe under circular imports); back-edges to `lazyLoader` / page-load are dynamic imports so this folder's static graph stays acyclic. Don't add a static import that pulls a heavy spine module in.
