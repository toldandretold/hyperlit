/**
 * GUARDRAIL: every overlay/modal-ish surface must declare its keyboard-focus
 * wiring in overlaySurfacesInventory.json.
 *
 * Why: modal panels that blur/block the page but let Tab wander behind them
 * (and offer no Escape) were the single biggest class of keyboard-accessibility
 * bugs found in the 2026-07 sweep (docs/a11y-findings.md). The fix mechanisms
 * exist — ContainerManager's trap and utilities/modalFocusTrap — so the only
 * way a new surface ships broken is by nobody noticing it exists. This test
 * makes new surfaces impossible to miss: it scans resources/css class
 * selectors and resources/js string literals for names matching
 * `-(overlay|backdrop|modal|sheet)` (plus `-menu` in CSS and components/), and
 * fails when a discovered name has no inventory entry, or an inventory entry
 * has gone stale.
 *
 * When this fails on YOUR new surface: wire a focus trap (Tab cycles inside,
 * Escape closes unless deliberately blocking, focus restored to the trigger —
 * see docs/a11y-findings.md "Keyboard model"), then register the surface with
 * its wiring status. `deferred:*` is allowed but is visible, reviewable debt.
 *
 * Runs in `npm test` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const JS_ROOT = path.join(ROOT, 'resources/js');
const CSS_ROOT = path.join(ROOT, 'resources/css');
const INVENTORY = JSON.parse(
  fs.readFileSync(path.join(HERE, 'overlaySurfacesInventory.json'), 'utf8')
).surfaces;

// Names that match the patterns but are not surfaces.
const FALSE_POSITIVES = new Set([
  'aria-modal', // ARIA attribute name, not a class
]);

const CSS_PATTERN = /\.([a-zA-Z0-9_-]*-(?:overlay|backdrop|modal|sheet))\b/g;
const CSS_MENU_PATTERN = /\.([a-zA-Z0-9_-]*-menu)\b/g;
const JS_PATTERN = /["']([a-zA-Z0-9_-]*-(?:overlay|backdrop|modal|sheet))["']/g;
const JS_MENU_PATTERN = /["']([a-zA-Z0-9_-]*-menu)["']/g;

function walk(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'archive') continue;
      out.push(...walk(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith('.bak')) {
      out.push(full);
    }
  }
  return out;
}

function scan(files, patterns) {
  const found = new Map(); // name -> first file seen
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        const name = m[1];
        if (FALSE_POSITIVES.has(name)) continue;
        if (!found.has(name)) found.set(name, path.relative(ROOT, file));
      }
    }
  }
  return found;
}

const discovered = new Map([
  ...scan(walk(CSS_ROOT, ['.css']), [CSS_PATTERN, CSS_MENU_PATTERN]),
  ...scan(walk(JS_ROOT, ['.ts', '.js']), [JS_PATTERN]),
  ...scan(walk(path.join(JS_ROOT, 'components'), ['.ts', '.js']), [JS_MENU_PATTERN]),
]);

describe('overlay surfaces declare their keyboard-focus wiring (gate)', () => {
  it('every discovered overlay/menu surface has an inventory entry', () => {
    const missing = [...discovered.entries()]
      .filter(([name]) => !(name in INVENTORY))
      .map(([name, file]) => `${name} (first seen in ${file})`);

    expect(
      missing,
      `New overlay surface(s) with no entry in overlaySurfacesInventory.json:\n  ${missing.join('\n  ')}\n` +
      `Wire a focus trap (ContainerManager set or utilities/modalFocusTrap — see ` +
      `docs/a11y-findings.md "Keyboard model") and register the surface with its wiring status.`
    ).toEqual([]);
  });

  it('every inventory entry still corresponds to a discovered surface (no stale entries)', () => {
    const stale = Object.keys(INVENTORY).filter((name) => !discovered.has(name));
    expect(
      stale,
      `Inventory entries no longer found in css/js — prune them: ${stale.join(', ')}`
    ).toEqual([]);
  });

  it('every wiring status uses a known vocabulary', () => {
    const allowed = /^(containerManager|trapModalFocus(:no-escape)?|dialog|non-modal:.+|inert:.+|deferred:.+|css-only:.+)$/;
    const bad = Object.entries(INVENTORY)
      .filter(([, v]) => !allowed.test(v.wiring))
      .map(([k, v]) => `${k}: "${v.wiring}"`);
    expect(bad, `Unknown wiring status(es): ${bad.join('; ')}`).toEqual([]);
  });
});
