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

## Keeping it at zero

- Any new violation now FAILS `npm run test:a11y` (no baseline slack left). Fix the regression, or — as a deliberate, diff-visible decision — add a baseline entry.
- The two still-skipped states (`reader-footnote-open`, and hyperlit-container coverage generally) need a footnote-bearing `E2E_READER_BOOK`; scanning them may surface new nodes — seed their baseline entries honestly when enabled.
- Scans run under the e2e user's persisted theme (currently sepia). Dark/light themes are unscanned for contrast; a future pass could parameterize theme.

## What "more accessible" means here, measurably

- **Primary:** total WCAG-A/AA violation nodes in `a11yBaseline.json`, weighted by impact (critical/serious tracked separately in `test-results/a11y/summary.json`). Started at 48, now 0.
- **Secondary:** number of `test.fixme` keyboard tests turned back into passing `test` (started at 2, now 0 — all 7 keyboard tests pass or skip on missing fixtures).
- **Tertiary:** count of distinct failing rule ids (started at 4: button-name, select-name, color-contrast, meta-viewport; now 0).
