# Accessibility (a11y) findings

Target standard: **WCAG 2.2 Level AA**. Baseline seeded 2026-07-05.

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

## Prioritized remediation queue

1. **Viewport zoom** (finding 4) — one line in `layout.blade.php`, clears 6 nodes across every page.
2. **Icon button names** (finding 1) — highest node count (27, critical); mechanical `aria-label` additions.
3. **Unlabeled select** (finding 2) — one control, critical.
4. **Settings Escape** (finding 6) — small handler, removes a keyboard trap.
5. **Skip link** (finding 5) — layout + CSS.
6. **Contrast** (finding 3) — design pass on the settings/user-page colors.

After any fix: re-run `npm run test:a11y`, and when a state improves, lower its entry in `a11yBaseline.json` to the printed count (the run prints the suggested value). Convert a fixed keyboard `test.fixme` back to `test`. Both are diff-visible proof of the improvement.

## What "more accessible" means here, measurably

- **Primary:** total WCAG-A/AA violation nodes in `a11yBaseline.json`, weighted by impact (critical/serious tracked separately in `test-results/a11y/summary.json`). Started at 48.
- **Secondary:** number of `test.fixme` keyboard tests turned back into passing `test` (started at 2).
- **Tertiary:** count of distinct failing rule ids (started at 4: button-name, select-name, color-contrast, meta-viewport).
