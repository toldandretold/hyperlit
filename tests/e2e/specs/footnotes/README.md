# Footnote integrity tests

End-to-end regression suite covering the footnote display-numbering subsystem.
Originally written to diagnose and lock down a user-reported integrity
mismatch where DOM showed `<sup fn-count-id="10">10</sup>` but IDB had stored
`<sup fn-count-id="8">8</sup>` for the same footnote.

## Background — the bug

`book_1769036890566`, edit-mode-exit trigger, no edits made that session.
Book fully loaded (272 IDB nodes = 272 PG nodes). User just navigated via TOC
and exited edit mode. Integrity check flagged node 12000:

```
DOM: becomes far less viable.10 But artificially restr   (length 1034)
IDB: becomes far less viable.8 But artificially restri   (length 1033)
```

The 2-position shift corresponded to exactly 2 footnotes the user had added
*earlier in the document* in prior sessions. Those prior renumbers only
persisted **rendered** nodes; node 12000 was off-screen at the time, so its
stored HTML kept `fn-count-id="8"` forever. The map (built fresh on load
from `node.footnotes` arrays) correctly said `10`. When this session's TOC
nav re-rendered the chunk containing node 12000, `applyDynamicFootnoteNumbers`
overwrote the DOM sup to `10` but never persisted. DOM and IDB diverged in
plain sight.

## Conceptual model — the invariant being tested

Three independent representations of footnote ordering coexist:

| # | Where | Shape | Written by |
|---|---|---|---|
| 1 | `node.content` HTML in IDB | `<sup fn-count-id="8" id="seq1_Fn..._abc">8</sup>` | `batch.js` (`processNodeContentHighlightsAndCites`) — from DOM at save time |
| 2 | `node.footnotes` array in IDB | `[{id: "seq1_Fn..._abc", marker: "8"}]` | Same as (1), plus `paste/utils/extractFootnoteIds.js` |
| 3 | In-memory `footnoteMap` | `Map<footnoteId, displayNumber>` | `FootnoteNumberingService.buildFootnoteMap` — walks all nodes by startLine, assigns 1,2,3… |

The renderer (`lazyLoaderFactory.js:applyDynamicFootnoteNumbers`) always
*overwrites* the rendered sup with the map's value — so the DOM equals the
map by construction.

**The invariant**: for every footnote sup in stored content, the literal
`fn-count-id` equals `footnoteMap.get(footnoteId)`. When this holds, the
renderer's overwrite is a no-op and the integrity check sees DOM == IDB.

The bug: this invariant is brittle. Anything that updates the map without
also updating stored content (e.g. a renumber that only persists rendered
nodes; cross-device sync; hydration that re-derives `node.footnotes` from a
different extractor) leaves stored content stale relative to the map.

## What each scenario tests

| Spec | What it does | What it would catch |
|---|---|---|
| **A** | Import a 16-footnote book; check invariants. | Importer producing inconsistent state between stored HTML and `node.footnotes`. |
| **B** | Import a 30-footnote book, fully load, TOC nav, enter/exit edit mode. Mirrors the iPhone bug user-action. | Any divergence from TOC-nav alone (no edits). |
| **C** | Import a 160-footnote, 483-node book (large enough that ~50 sups render, ~110 are unrendered). Insert one footnote near the top. TOC nav to the end. Exit edit mode. | The original bug — renumber only persists rendered nodes. Before the reconcile fix: 111 violations after the insert. After fix: 0. |
| **D** | Delete a footnote in the middle, TOC nav around. | Shrinking renumber leaving stale stored content. |
| **E** | Insert a paragraph containing a sup at runtime (paste-time path). | Paste linker creating array/content mismatches. |
| **F** | Open a footnote sub-book, edit inside, close, reopen. | Parent/sub-book footnote ID bleed. |
| **G** | Snapshot `node.footnotes` arrays, reload the page (forces full hydration), snapshot again, assert byte-for-byte preservation. | `indexedDB/hydration/rebuild.js`'s extractor disagreeing with what `batch.js` wrote. |
| **H** | Directly corrupt one IDB node's stored sup to `fn-count-id="999"`, reload (so `window.nodes` picks up the corruption), TOC nav to render the chunk, assert IDB is healed back to the map's value. | Render-time self-heal — proves the renderer not only fixes the DOM but writes the fix back to IDB. |

## The fix — two-layer self-heal

Both layers live in `resources/js/footnotes/FootnoteNumberingService.js` and
`resources/js/lazyLoaderFactory.js`. They are independent and complementary.

### Layer 1 — `reconcileStoredFootnoteContent` (batch, on renumber)

In `FootnoteNumberingService.js`, every call to `rebuildAndRenumber` walks
every IDB node for the book and rewrites any stored sup whose `fn-count-id`
disagrees with the current map. Each rewrite is queued for server sync.

Fires on: every footnote add/delete (via `batch.js` auto-renumber trigger),
and after `backgroundDownloader.js` finishes downloading the full dataset.

**Verified by scenario C** — without it: 111 violations after one footnote
insert at the top of a 483-node book. With it: 0.

### Layer 2 — render-time self-heal (lazy, on chunk render)

In `lazyLoaderFactory.js:applyDynamicFootnoteNumbers`, when the renderer
overwrites a sup whose `oldValue !== newValue`, it queues the affected
`{ bookId, startLine }` pair. A `setTimeout(0)`-deferred flush calls
`batchUpdateIndexedDBRecords([{ id }], { bookId, skipFootnoteRenumber: true })`
for each queued node — same path the renumber uses for rendered nodes.

`skipFootnoteRenumber: true` is critical: without it every chunk render
would trigger another `rebuildAndRenumber`, infinite loop.

Fires on: any chunk render via `createChunkElement` (TOC nav, scroll-based
lazy load, sub-book open).

**Verified by scenario H** — without it: corrupting IDB and re-rendering
leaves IDB stale (DOM gets fixed by the renderer's existing logic, but the
fix is never persisted). With it: corrupted node is healed when the chunk
renders, even with no renumber pending.

### Why both layers

- **Layer 1** catches the whole book in one pass when a renumber fires. Fast
  convergence after any footnote operation.
- **Layer 2** catches anything Layer 1 missed — books loaded with stale IDB
  inherited from a session that predates Layer 1; offline / background-
  download failures; edge cases.

They don't fight each other. Layer 2 uses `skipFootnoteRenumber: true` so
it can't recursively trigger Layer 1.

## Test helpers

- **`helpers/idbInspect.js`** — page-evaluate functions for dumping IDB,
  extracting sups from stored HTML (regex-based, runs in Node), snapshotting
  the in-memory `footnoteMap`, and cross-checking the invariant. Returns
  typed violation objects (`map_disagrees_with_html`, `array_missing_id`,
  `content_missing_id`, `map_missing_id`, `duplicate_id_in_*`).
- **`helpers/sourceFixtures.js`** — `generateFootnoteHeavyMarkdown` and
  `importFootnoteHeavyBook` for deterministic test books with configurable
  chapter/paragraph/footnote counts. Use `chapters: 15+, paragraphsPerChapter:
  12+, footnotesPerChapter: 5+` to force a meaningful rendered-vs-unrendered
  split.

## Diagnostic instrumentation (in app code)

Gated behind `window.__fnDiag.enabled` — off in production:

- **`FootnoteNumberingService.js`** exposes `window.__fnDiag.snapshot()` →
  `{ bookId, mapEntries, rebuildCount }`. Increments `rebuildCount` each
  time `buildFootnoteMap` runs.
- **`lazyLoaderFactory.js`** pushes to `window.__fnDiag.domMutations` (capped
  at 100) whenever the renderer overwrites a sup with a different value.

Tests enable the hook via `addInitScript(enableFnDiagScript)` (in
`helpers/idbInspect.js`).

## Running

```sh
# All footnote scenarios
npm run test:e2e -- footnotes/footnote-integrity.spec.js --reporter=line

# Just one
npm run test:e2e -- --grep "C\. Add footnote"
```

Requires the dev server on `localhost:8000` and credentials in
`tests/e2e/.env.e2e`. Auth setup fixture runs first and caches the session
to `tests/e2e/fixtures/.auth-state.json`.

## What to do if one of these tests fails

1. **The checkpoint output is the diagnostic.** Every scenario logs a
   `[checkpoint]` summary at each phase boundary with `violationCount`,
   `domMutationCount`, `rebuildCount`, and a `violationsByKind` breakdown.
2. **`violationCount > 0` means the invariant broke.** Look at
   `firstFewViolations`. The `kind` field tells you which representation
   diverged:
   - `map_disagrees_with_html` — the smoking gun for the original bug.
     Stored HTML's `fn-count-id` differs from what the map says. Either
     Layer 1 (`reconcileStoredFootnoteContent`) or Layer 2 (render-time
     heal) regressed.
   - `array_missing_id` / `content_missing_id` — stored content and
     `node.footnotes` arrays got out of sync. Look at `batch.js` and the
     paste / hydration paths.
   - `map_missing_id` — a sup in stored content references a footnote ID
     the map doesn't know about. Map-building regression in
     `buildFootnoteMap`.
   - `duplicate_id_in_*` — the same footnote ID appears twice in one
     node's content or footnotes array. Paste handler or footnote inserter
     regression.
3. **`domMutationCount > 0` after a scenario that didn't add/delete
   footnotes** means the renderer is fixing up the DOM — there's drift
   that the test methodology didn't anticipate.
4. Attachments are written to the Playwright HTML report. Each scenario
   attaches snapshot JSON and integrity events. Run with `--reporter=html`
   to browse them.

## Related files

- `resources/js/footnotes/FootnoteNumberingService.js` — map builder,
  `rebuildAndRenumber`, `reconcileStoredFootnoteContent`.
- `resources/js/lazyLoaderFactory.js` — `applyDynamicFootnoteNumbers` and
  the render-time self-heal queue.
- `resources/js/integrity/verifier.js` — the integrity check that exposes
  the bug. Compares DOM textContent vs textContent derived from stored
  `node.content`.
- `resources/js/indexedDB/nodes/batch.js` — `processNodeContentHighlightsAndCites`,
  writes both `node.content` and `node.footnotes` from DOM at save time.
- `resources/js/indexedDB/hydration/rebuild.js` — re-derives `node.footnotes`
  from content HTML on load. Currently safe for the no-anchor format the
  importer produces (scenario G verifies this).

## Investigation history

Full plan and reasoning trail at `~/.claude/plans/transient-wiggling-emerson.md`.
