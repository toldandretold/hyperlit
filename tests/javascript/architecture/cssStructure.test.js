/**
 * GUARDRAIL: CSS reorganization structure + mega-file ratchet.
 *
 * resources/css is organized as: theme/ (tokens + theme layers), base/ (page-agnostic
 * foundations), components/ (one file per feature, named after its resources/js folder),
 * pages/ (one entry per blade view — each blade @vite()s app.css + its pages/*.css, and
 * the entry's @import order IS the cascade order). The legacy mega-files (buttons.css /
 * containers.css) are residuals being drained verbatim into components/*.css; migration
 * changes are verified byte-identical with scripts/css-cascade-snapshot.mjs.
 *
 * Three gates:
 *  1. RATCHET — residual line counts may only go DOWN (cssBaseline.json). When you
 *     extract a section the test prints the new count; copy it into the baseline.
 *  2. PLACEMENT — every .css file must live in theme/ base/ components/ pages/, or be
 *     one of the named legacy residuals. No new top-level strays.
 *  3. ENTRY/IMPORT EXCLUSIVITY — a file that is BOTH a Vite entry (vite.config.js input)
 *     and reachable via @import from an entry gets built twice and double-applied.
 *     The sets must not intersect.
 *  4. NO ORPHANS — every css file must be reachable from an entry via @import, be an
 *     entry itself, or be on the explicit not-yet-wired allowlist.
 *
 * Runs in `npm test` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CSS = path.join(ROOT, 'resources/css');
const BASELINE = JSON.parse(fs.readFileSync(path.join(HERE, 'cssBaseline.json'), 'utf8'));

// Top-level legacy residuals (drained by the migration) + the shared base entry.
const LEGACY_TOP_LEVEL = new Set(['app.css', 'buttons.css', 'containers.css']);

// Known intentionally-unwired files (not @imported, not entries — yet).
const UNWIRED_ALLOWLIST = new Set([
  'components/divEditor.css', // parked: was a dead vite input pre-reorg; wires up when divEditor styles are extracted
  'theme/custom-theme-template.css', // documentation template for user themes
]);

function walkCss(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCss(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const rel = (abs) => path.relative(CSS, abs).split(path.sep).join('/');

// CSS entries listed as Vite inputs (quoted strings inside the laravel({ input: [...] })).
function viteCssEntries() {
  const src = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
  const inputBlock = src.match(/input:\s*\[([\s\S]*?)\]/);
  expect(inputBlock, 'could not locate the laravel input array in vite.config.js').toBeTruthy();
  return [...inputBlock[1].matchAll(/['"]([^'"]+\.css)['"]/g)].map((m) => m[1]);
}

// Transitive relative @import targets of a css file (comments stripped first —
// they may contain the literal text "@import" or commented-out imports).
function importTargets(file, acc = new Set()) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const m of src.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")]+)['"]?\s*\)?\s*[^;]*;/g)) {
    const target = m[1];
    if (!target.startsWith('./') && !target.startsWith('../')) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!acc.has(resolved) && fs.existsSync(resolved)) {
      acc.add(resolved);
      importTargets(resolved, acc);
    }
  }
  return acc;
}

describe('CSS structure (reorg gates + mega-file ratchet)', () => {
  const groups = Object.keys(BASELINE).filter((k) => !k.startsWith('_'));

  for (const relPath of groups) {
    it(`${relPath}: line count must not exceed its baseline (${BASELINE[relPath]})`, () => {
      const full = path.join(ROOT, relPath);
      if (!fs.existsSync(full)) {
        // Residual fully drained and deleted — remove its baseline entry.
        throw new Error(`${relPath} no longer exists; delete its entry from cssBaseline.json`);
      }
      // Newline count = `wc -l`, so baselines can be checked/updated with wc.
      const current = (fs.readFileSync(full, 'utf8').match(/\n/g) || []).length;
      const baseline = BASELINE[relPath];

      if (current < baseline) {
        console.warn(
          `[cssStructure] ${relPath}: ${current} lines (baseline ${baseline}). ` +
          `Lower the baseline in cssBaseline.json to ${current} to keep the ratchet tight.`
        );
      }

      expect(
        current,
        `${relPath} GREW (${current} > baseline ${baseline}). New styles belong in ` +
        `resources/css/components/<feature>.css (named after the resources/js folder), ` +
        `imported from the pages/*.css entries — not in the legacy residuals.`
      ).toBeLessThanOrEqual(baseline);
    });
  }

  it('every css file lives in theme/ base/ components/ pages/ (or is a named legacy residual)', () => {
    const strays = walkCss(CSS)
      .map(rel)
      .filter((r) => !/^(theme|base|components|pages)\//.test(r) && !LEGACY_TOP_LEVEL.has(r));
    expect(
      strays,
      `stray css file(s) outside the structure: ${strays.join(', ')}. ` +
      `Place feature styles in components/<feature>.css and wire them via a pages/*.css entry.`
    ).toEqual([]);
  });

  it('no css file is both a Vite entry and an @import target (double-bundle guard)', () => {
    const entries = viteCssEntries();
    const entryAbs = entries.map((e) => path.join(ROOT, e));
    const imported = new Set();
    for (const e of entryAbs) importTargets(e, imported);
    const both = entryAbs.filter((e) => imported.has(e)).map((e) => path.relative(ROOT, e));
    expect(
      both,
      `listed as BOTH a vite.config.js input and reachable via @import (built twice, ` +
      `applied twice): ${both.join(', ')}. Remove it from the input list.`
    ).toEqual([]);
  });

  it('every css file is reachable from an entry (no orphans)', () => {
    const entryAbs = viteCssEntries().map((e) => path.join(ROOT, e));
    const reachable = new Set(entryAbs);
    for (const e of entryAbs) importTargets(e, reachable);
    const orphans = walkCss(CSS)
      .filter((f) => !reachable.has(f))
      .map(rel)
      .filter((r) => !UNWIRED_ALLOWLIST.has(r));
    expect(
      orphans,
      `unreachable css file(s) — not a vite entry, not @imported by one: ${orphans.join(', ')}. ` +
      `Wire it into a pages/*.css entry (or add to UNWIRED_ALLOWLIST with a reason).`
    ).toEqual([]);
  });
});
