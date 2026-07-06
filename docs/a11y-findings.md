# Accessibility (a11y) findings

Target standard: **WCAG 2.2 Level AA**. Baseline seeded 2026-07-05 at **48 violation nodes**; remediated to **0** the same day (see "Remediation applied" below). The findings sections are kept as the audit record.

## What the standard is, and why AA

The Web Content Accessibility Guidelines (WCAG) define whether a page is usable by people with disabilities — low vision, blindness, motor impairment, cognitive load. Conformance has three levels: **A** (must-have basics), **AA** (the level referenced by essentially every accessibility law and the normal industry target), and **AAA** (aspirational, rarely required wholesale). We target **AA**: everything at A and AA, not AAA. Each finding below cites its specific success criterion (e.g. "1.4.3 Contrast (Minimum)").

## How this is measured

Two complementary layers, both run by `npm run test:a11y` (Playwright, chromium, against the dev server on `:8000`):

1. **Automated axe-core scan** — `tests/e2e/specs/a11y/axe-scan.spec.js` drives the app into each page-state and runs [axe-core](https://github.com/dequelabs/axe-core) with the WCAG 2.2 A/AA rule tags. Axe is deterministic but only catches roughly 30–50% of WCAG issues — the machine-checkable ones (contrast, accessible names, roles, document structure). It cannot judge whether a flow makes sense or is operable.
2. **Scripted keyboard / focus tests** — `tests/e2e/specs/a11y/keyboard.spec.js` covers the operability half axe can't see: tab-reachability, Enter/Escape activation, focus-visible indicators, and focus restoration. A criterion the app fails today is recorded as `test.fixme('… — WCAG x.y.z', …)` so the suite stays green while the gap stays countable.

Not yet covered (future work): screen-reader sense-making (VoiceOver/NVGA spot checks), reduced-motion preferences, and the `reader-footnote-open` / hyperlit-container states — these need a footnote-bearing `E2E_READER_BOOK` (the current seed book has none, so those tests `test.skip`).

Page-states scanned: `home`, `user`, `reader`, `reader-edit-mode`, `reader-settings-open`, `reader-toc-open` (and `reader-footnote-open`, currently skipped).

## Baseline snapshot (2026-07-05)

**48 WCAG-A/AA violation nodes** across 4 distinct rules, plus 2 keyboard gaps.

| Impact | Nodes | Rule |
|---|---|---|
| critical | 27 | button-name |
| critical | 1 | select-name |
| serious | 14 | color-contrast |
| moderate | 6 | meta-viewport |

The machine record is `tests/e2e/specs/a11y/a11yBaseline.json` (per-state, per-rule node counts). **`git log` on that file is the auditable proof that accessibility improved** — the ratchet only lets the numbers go down.

## Findings, ranked by impact

### 1. Icon-only buttons have no accessible name — critical (WCAG 4.1.2 Name, Role, Value)

27 button nodes across every page-state expose no text a screen reader can announce — they read as "button" with no purpose. Confirmed offenders: `#userButton`, `#settingsButton`, `#editButton`, `#cloudRef`, and the edit-toolbar cluster (11 nodes in `reader-edit-mode`). These are SVG-icon buttons with no text child, `aria-label`, or `title`.

Remediation: add an `aria-label` (or visually-hidden text span) to each icon button describing its action — e.g. `aria-label="Settings"`, `aria-label="Edit"`, `aria-label="Sync status"`. Several buttons in `reader.blade.php` already do this correctly (`aria-label="New book"`, `aria-label="Toggle navigation menu"`) — extend the same pattern. axe helpUrl: https://dequeuniversity.com/rules/axe/4.10/button-name

### 2. Unlabeled `<select>` on the user page — critical (WCAG 4.1.2 Name, Role, Value)

1 node: a `<select>` control with no associated `<label>` / `aria-label`, so its purpose isn't announced. Remediation: add a `<label for>` or `aria-label`. helpUrl: https://dequeuniversity.com/rules/axe/4.10/select-name

### 3. Low-contrast text — serious (WCAG 1.4.3 Contrast (Minimum))

Up to 14 nodes fall below the 4.5:1 minimum contrast ratio for normal text. Locations:
- Settings panel: `#gateFilterButton`, the slider icon `label[for="textSizeSlider"] > .slider-icon`, the size readout `#textSizeValue` (grey `#888` on dark).
- User page: shelf full-text preview (`.shelf-fulltext-text`) and book-card titles (`#27 > strong`, `#28 > strong`).

Remediation: darken/lighten the affected foreground or background so each pair clears 4.5:1 (use a contrast checker; the `#888`-on-dark cases are the worst). helpUrl: https://dequeuniversity.com/rules/axe/4.10/color-contrast

### 4. Viewport disables zoom — moderate (WCAG 1.4.4 Resize Text)

`resources/views/layout.blade.php:11` sets `<meta name="viewport" content="… user-scalable=no">`, which prevents pinch-to-zoom — a hard blocker for low-vision users. Remediation: remove `user-scalable=no` (and any `maximum-scale`) from the viewport meta. This is a one-line fix that clears the rule on every page-state at once. helpUrl: https://dequeuniversity.com/rules/axe/4.10/meta-viewport

### 5. No skip-to-content link — keyboard gap (WCAG 2.4.1 Bypass Blocks)

On `/`, the first Tab lands on `#userButton`; there is no "skip to content" link, so a keyboard user must tab through the whole nav on every page. Remediation: add a visually-hidden anchor (revealed on focus) as the first focusable element in the layout, targeting the main content landmark. Tracked by the fixme in `keyboard.spec.js` (skip-to-content — WCAG 2.4.1).

### 6. Settings panel can't be closed with the keyboard — keyboard gap (WCAG 2.1.2 No Keyboard Trap)

The settings container (`resources/js/components/settingsContainer/index.ts`) closes only via an `#settings-overlay` pointer click or the toggle button — there is no Escape handler. A keyboard-only user who opens settings is stuck. Remediation: wire an `Escape` keydown to the container's close path. Tracked by the fixme in `keyboard.spec.js` (settings closes on Escape — WCAG 2.1.2).

## Remediation applied (2026-07-05) — 48 nodes → 0, both keyboard gaps closed

All six findings were fixed the same day the baseline was seeded. `a11yBaseline.json` is now all-zeros and the ratchet holds it there. What was done, for the record:

1. **Viewport zoom** (finding 4): removed `user-scalable=no` from the viewport meta in `layout.blade.php`.
2. **Icon button names** (finding 1): `aria-label` on every icon-only button — `#userButton` ("Account"), `#settingsButton` ("Settings"), `#editButton` ("Toggle edit mode"), `#cloudRef` ("Sync status"), `#toc-toggle-button` ("Table of contents"), the settings `#searchButton` ("Search in text"), and the edit toolbar (`bold/italic/heading/blockquote/code/undo/redo` in `reader.blade.php`).
3. **Unlabeled selects** (finding 2): `aria-label="Sort books"` on the JS-rendered sort `<select>`s in `resources/js/components/shelves/shelfSortAndSearch.ts` and `shelfHeader.ts`.
4. **Contrast** (finding 3): sepia-scoped fixes in `sepia-theme.css` — library-card title text darkened to `#96490C` via a `.libraryCard strong` override (the `--hyperlit-orange` VARIABLE is untouched so decorative art like the lava-lamp keeps its hue); settings buttons get a light sepia wash instead of the muddy grey; slider label/value opacities bumped `0.6/0.7 → 0.8` in `settingsContainer.css` + `shelves.css`. Gotcha: `sepia-theme.css` is imported into a CSS `@layer`, so overrides there need `!important` to beat unlayered component CSS.
5. **Skip link** (finding 5): visually-hidden-until-focus "Skip to content" anchor as the first focusable in `layout.blade.php`, `#main-start` targets in the three page blades, styles in `base/foundation.css`. SPA integration needed two guards in `LinkNavigationHandler`: the click interceptor skips `.skip-link` (native fragment behavior), and the popstate handler early-returns on `#main-start` (fragment clicks fire popstate; without the guard, home routed it as a null-book navigation and rewrote the URL to `/null#main-start`). The keyboard test asserts both. Note: macOS Safari/Firefox don't Tab to links by default — verify in Chrome or with Option+Tab.
6. **Modal focus trap + Escape** (finding 6, later broadened): found live after the first pass — user/newbook panels opened with a blurred backdrop but Tab wandered the inert page behind them. Now the `ContainerManager` base owns a generic modal focus trap (`_engageFocusTrap`/`_releaseFocusTrap`): for `user-container`, `newbook-container`, `settings-container`, `source-container` (NOT `hyperlit-container` — sub-book content with its own history-driven close and edit-mode keyboard semantics), Tab cycles inside the open panel, Escape closes it, and focus returns to the trigger button. Subclasses that override `openContainer`/`closeContainer` without `super` (user, newbook, source) call the hooks in their overrides. `UserContainerManager.closeContainer` also adopted newbook's "close interrupts an in-flight open animation" semantics — its old `isAnimating` guard silently dropped Escape during the ~1s open window. Covered by the two "traps Tab, closes on Escape, restores focus" tests in `keyboard.spec.js`.

Verified: `npm run test:a11y` twice back-to-back — 12 passed / 0 WCAG-A/AA nodes across all 6 scanned states; both keyboard `test.fixme`s converted back to passing `test`s; full vitest suite (1097) and the grand-tour isolation phases still green.

## Round 2 (same day, found by real keyboard use)

Live keyboard testing after the first pass surfaced four more gaps, all fixed and test-guarded:

7. **Invisible focus on links — the "can't tab to card arrows" bug**: a global `a { outline: none }` in `base/contentMisc.css` suppressed every link's focus ring, so Tab reached the card ↗ / actions / DOI links invisibly. Replaced with `a:focus-visible` (2px accent ring, keyboard-only — mouse clicks stay ring-free). Guard: "library-card links show a focus ring" test.
8. **Modal focus traps** (see Remediation item 6) — user/newbook panels let Tab wander the blurred page behind them.
9. **Encrypt checkbox ignored Enter**: native checkboxes only toggle on Space; the newbook popup's delegated keydown now maps Enter on `#createEncrypted` to a toggle as well. Guard: "encrypt checkbox toggles with Enter and Space" test.
10. **E2EE unlock dialog unreachable by keyboard**: `e2ee/ui/unlockModal.ts` never moved focus into the dialog. New zero-import leaf `utilities/modalFocusTrap.ts` (`trapModalFocus(root, {onEscape})` → release fn) seats focus on the first button, cycles Tab, Escape cancels, and restores focus on close. The leaf serves any future ad-hoc dialog; registry-managed containers use `ContainerManager`'s own trap. (No e2e guard — driving it needs a passkey-encrypted book; verify manually.)

## Round 3 (2026-07-05): the systematic sweep — inventory, traps everywhere, hop layer

Rounds 1–2 fixed surfaces one at a time as the user found them. Round 3 replaced whack-a-mole with a closed system:

**Inventory + drift gate.** A code sweep enumerated every transient surface (28 names once the CSS/string scan ran — more than the manual sweep found, which is the point). Each is registered in `tests/javascript/architecture/overlaySurfacesInventory.json` with its wiring status; `overlaySurfaces.test.js` (in `npm test`) scans `resources/css` + `resources/js` for `-(overlay|backdrop|modal|sheet|menu)` names and fails on any unregistered or stale entry. New surfaces cannot ship unwired silently — worst case they ship as visible `deferred:*` debt. CLAUDE.md gained the matching review gate ("Overlay surfaces MUST declare focus wiring").

**Trap infrastructure.** `utilities/modalState.ts` (global modal stack — only the TOP trap owns Tab/Escape, so stacked modals compose; also the "modal open" signal for the hop layer). `utilities/modalFocusTrap.ts` hardened: `getClientRects()` visibility check with unfiltered fallback + rAF re-seat — this was the root cause of the unlock modal being Tab-dead on the real reader open-gate (mid-boot layout reported zero visible buttons; the old trap cancelled Tab with nowhere to go). Same fixes mirrored in `ContainerManager`.

**Wired in Round 3**: TOC panel (now in the ContainerManager trap set), `dialog.ts` confirm/alert (trap + focus restore), shelf preview, add-to-shelf menu (+Escape, had none), shelf visibility/delete confirms (migrated to `confirmDialog`), access-guard alerts ×3 (+Escape=go home), edit-login alert, import footnote-audit alert (Escape=proceed), integrity data-loss modal (trap, Escape deliberately blocked), recovery-code overlay (trap, Escape deliberately blocked — Done is gated on the "I saved it" checkbox), source visibility panel (stacks above the container trap), logo-nav menu (Escape+refocus, non-modal), search toolbar (focus restore). Deferred (in the inventory): hyperlitContainer (history-driven close + edit-mode keys need their own design), citation-mode toolbar, edit submenus, selection toolbar, paste/import/AI-viz overlays.

**Real-gate test fixtures.** `php artisan e2e:seed-fixtures` seeds `E2E_ENCRYPTED_BOOK` (drives the REAL E2EE open-gate — `e2ee-unlock-gate.spec.js` regression-guards the boot-time seat bug) and `E2E_A11Y_BOOK` (one of every in-text interactable, un-skipping footnote specs). `modal-surfaces.spec.js` runs one shared keyboard contract over every reachable surface (real gestures) plus direct-invoke probes for deep-state modals.

## The keyboard model (how a keyboard user drives Hyperlit)

Standard: WCAG 2.1.1 requires all functionality be keyboard-operable — NOT that every clickable thing be a Tab stop. Content in Hyperlit is unbounded (a book's thousands of annotations; a 100-card home feed); making it Tab stops buries the chrome. The ARIA Authoring Practices answer is a composite/hop pattern (Gmail's `j`/`k`, GitHub's PR navigation): few Tab stops, dedicated keys inside content. **One rule, every page — Tab never enters content; `n`/`p` always does.**

- **Tab** = a short chrome loop only, in visual reading order (WCAG 2.4.3): skip link → user → + → (page controls: search, feed tabs / logo, cloudRef, edit, TOC) → settings. Under ~12 stops on every page. ALL content links are `tabindex="-1"`: rendered content via `lazyLoader/chunkRender.ts` (reader books AND home/user card feeds — everything except sub-book containers, whose keyboard design is deferred), static homepage copy links directly in `home.blade.php`. The save path strips `tabindex` (`indexedDB/nodes/contentProcessor.ts`) so it never persists into stored content.
- **n / j** next, **p / k** previous content interactable — reader annotations (hyperlight `mark`, hypercite `u`, footnote `sup`, citations, links) and home/user card links alike — in DOM order, scrolled into view with a visible focus ring; **Enter** opens it; **?** shows the shortcut list. Module: `components/contentHopper/contentHopper.ts` (ButtonRegistry, reader+home+user; roots `.main-content` + `.welcome-copy`). Inert while typing, in edit mode, or while any modal is open.
- **Open hyperlit container = the hop territory.** When a footnote/highlight/hypercite panel is open, `n`/`p` hop ITS links/annotations (top layer only when stacked — Enter goes deeper, Escape pops back out, and the territory returns to the main book). Tab is deliberately not trapped there yet (multiple content areas + edit mode + stacking need their own design — `deferred:` in the overlay inventory), but hop + Escape makes the container fully operable.
- **Edit mode**: letter keys must type, so hopping is off; content navigation is the caret (arrows, Home/End) + native scroll — standard editor behavior. Modifier chords (Alt+N/P) are the upgrade path if ever wanted.
- **Arrows / Space / PageUp / PageDown** are NEVER intercepted — native scrolling everywhere (a deliberate decision over the ARIA arrow-roving variant: readers expect arrows to scroll).
- **Modals** (settings, user, new-book, source, TOC, dialogs, previews, menus): focus seats inside on open, Tab cycles inside, Escape closes (except deliberately blocking modals: integrity data-loss, recovery code), focus returns to the trigger.
- Known limitations: the hop layer sees only rendered DOM (lazy-loaded chunks/cards join as they load); sub-book containers keep native tabbing until their own design lands.

Specs: `content-hopper.spec.js` (Tab-loop length, hop order, Enter-opens-footnote, guards) + `modal-surfaces.spec.js` + `keyboard.spec.js`, all in `npm run test:a11y`.

## Keeping it at zero

- Any new violation now FAILS `npm run test:a11y` (no baseline slack left, bar one recorded debt below). Fix the regression, or — as a deliberate, diff-visible decision — add a baseline entry.
- The footnote states are now scannable (fixture book from `e2e:seed-fixtures`). One debt node recorded: `link-in-text-block` — content links are distinguishable only by color (the app deliberately renders links without underlines). Fixing it is a DESIGN decision (underline or otherwise mark content links); until then it lives in the baseline as visible debt.
- Escape now closes the footnote/highlight container (mirrors the overlay click's history-driven close); full hyperlit-container focus management (trap, restore, stacked layers, edit mode) remains `deferred:` in the overlay inventory.
- Scans run under the e2e user's persisted theme (currently sepia). Dark/light themes are unscanned for contrast; a future pass could parameterize theme.

## What "more accessible" means here, measurably

- **Primary:** total WCAG-A/AA violation nodes in `a11yBaseline.json`, weighted by impact (critical/serious tracked separately in `test-results/a11y/summary.json`). Started at 48, now 0.
- **Secondary:** number of `test.fixme` keyboard tests turned back into passing `test` (started at 2, now 0 — all 7 keyboard tests pass or skip on missing fixtures).
- **Tertiary:** count of distinct failing rule ids (started at 4: button-name, select-name, color-contrast, meta-viewport; now 0).
