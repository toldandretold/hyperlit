/**
 * `hidden` is only as strong as the UA stylesheet.
 *
 * `[hidden] { display: none }` is a UA rule with the lowest possible weight, so
 * ANY author declaration that sets `display` on the same element outranks it and
 * the element stays on screen with `hidden` set. Nothing warns you: the
 * attribute is there in the DOM, the JS that set it ran, and the element is
 * visible anyway.
 *
 * That shipped on /maintainer/hypercites. `.hx-occurrence { display: inline-flex }`
 * kept the occurrence picker rendered for every candidate, including the
 * single-match ones renderOccurrencePicker hides it for — so the ↑↓ arrows sat
 * there looking live while moveOccurrence returned early, having no second
 * location to step to. A visible-but-inert control reads as a broken feature.
 *
 * The fix is to scope the rule (`.x:not([hidden])`) or to use a class instead of
 * the attribute. This test scans the console's own blade for elements carrying
 * `hidden` and fails if its stylesheet gives one of them an unscoped `display`.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const BLADE = resolve(ROOT, 'resources/views/maintainer-hypercites.blade.php');
const STYLESHEET = resolve(ROOT, 'resources/css/pages/maintainer-hypercites.css');

/** Ids and classes on elements that carry the `hidden` attribute in the blade. */
function hiddenSelectors(blade) {
  const selectors = new Set();
  // Opening tags containing a bare `hidden` attribute.
  for (const tag of blade.match(/<[a-z][^>]*\shidden(?=[\s/>])[^>]*>/gi) ?? []) {
    const id = tag.match(/\sid="([^"]+)"/i);
    if (id) selectors.add(`#${id[1]}`);
    const classes = tag.match(/\sclass="([^"]+)"/i);
    for (const name of classes ? classes[1].trim().split(/\s+/) : []) {
      selectors.add(`.${name}`);
    }
  }
  return selectors;
}

/**
 * Selectors given a `display` other than `none` WITHOUT being made safe.
 *
 * Two forms are safe and both are in use here: scoping the rule itself
 * (`.x:not([hidden])`), or pairing it with a companion override
 * (`.x[hidden] { display: none }`, which is what #hx-mostcited-tab does). Only
 * an unscoped rule with no companion is reported.
 */
function unscopedDisplayRules(css) {
  const displayed = new Map();  // bare selector → the rule as written
  const neutralised = new Set(); // bare selector → has a [hidden] display:none

  // Comments MUST go first. Without this every rule preceded by a comment has
  // the comment's tail glued onto its selector, which contains spaces, and the
  // descendant-selector skip below then quietly discards the rule — the scan
  // passes having examined almost nothing. (That is exactly how the first cut
  // of this test went green against the very bug it was written for.)
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  for (const [, selectorList, body] of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const display = body.match(/(?:^|[;\s])display\s*:\s*([^;]+)/i);
    if (!display) continue;
    const isNone = display[1].trim() === 'none';

    for (const raw of selectorList.split(',')) {
      const selector = raw.trim();
      if (!selector || selector.startsWith('@')) continue;
      // Only rules targeting the element ITSELF, not a descendant of it.
      if (/[\s>+~]/.test(selector)) continue;

      const scoped = /:not\(\[hidden\]\)/.test(selector);
      const hiddenQualified = !scoped && /\[hidden\]/.test(selector);
      // Strip the [hidden] qualifier and any pseudo-classes: `.x:hover` and
      // `.x[hidden]` both describe `.x`.
      const bare = selector
        .replace(/:not\(\[hidden\]\)/g, '')
        .replace(/\[hidden\]/g, '')
        .replace(/::?[a-z-]+(\([^)]*\))?/gi, '');
      if (!bare) continue;

      if (hiddenQualified && isNone) {
        neutralised.add(bare);
      } else if (!isNone && !scoped && !hiddenQualified) {
        displayed.set(bare, selector);
      }
    }
  }

  for (const safe of neutralised) displayed.delete(safe);

  return displayed;
}

describe('hidden attribute is not defeated by an author display rule', () => {
  test('no hidden-toggled element in the hypercite console gets an unscoped display', () => {
    const hidden = hiddenSelectors(readFileSync(BLADE, 'utf8'));
    const displays = unscopedDisplayRules(readFileSync(STYLESHEET, 'utf8'));

    const broken = [...hidden]
      .filter((selector) => displays.has(selector))
      .map((selector) => `${displays.get(selector)} — write ${selector}:not([hidden]), `
        + `or add ${selector}[hidden] { display: none }`);

    expect(broken, `These elements carry \`hidden\` but are given a display that outranks `
      + `the UA \`[hidden] { display: none }\` rule, so they stay visible:\n  `
      + broken.join('\n  ')).toEqual([]);
  });

  test('the scan actually sees the console\'s hidden elements and its display rules', () => {
    // A silent-pass guard: if either regex stopped matching, the test above
    // would go green having checked nothing at all.
    const hidden = hiddenSelectors(readFileSync(BLADE, 'utf8'));
    expect(hidden.has('#hx-occurrence')).toBe(true);
    expect(hidden.has('#hx-revert')).toBe(true);
    expect(hidden.has('#hx-mostcited-tab')).toBe(true);

    const displays = unscopedDisplayRules(readFileSync(STYLESHEET, 'utf8'));
    expect(displays.has('.hx-selected-actions')).toBe(true); // never hidden — fine
    expect(displays.has('.hx-occurrence')).toBe(false);      // scoped with :not([hidden])
    expect(displays.has('#hx-mostcited-tab')).toBe(false);   // companion [hidden] rule
  });
});
