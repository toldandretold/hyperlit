/**
 * GUARDRAIL: interactive components must go through ButtonRegistry.
 *
 * The bug this exists to prevent: `resources/js/components/containerDragger/containerDragger` (the container
 * resize dragger) self-instantiated `window.containerDragger = new ContainerDragger()`
 * at module load and was wired ONLY into reader.blade.php's `@vite([...])` block. That
 * block runs on a full reader page load but NOT on an in-SPA book open, so after SPA
 * navigation the dragger never existed and the resize edges were live-but-unwired. No
 * unit test caught it (the only real-drag e2e test self-skipped), and the SPA grand tour
 * used a synthetic probe that can't detect a missing document listener.
 *
 * The lesson, enforced here so it can't recur, has two precise, low-false-positive shapes:
 *
 *   1. reader.blade.php's @vite JS list may ONLY contain approved bootstraps — never an
 *      interactive component loaded as a side-effect. Components live in ButtonRegistry
 *      (registerComponents.js), which viewManager re-inits on EVERY reader entry
 *      (full-load AND SPA), so they survive navigation.
 *
 *   2. No module may self-instantiate a global UI singleton (`window.X = new Y()`) at the
 *      top level. That is precisely the drag.js smell — a singleton whose lifecycle nobody
 *      owns. Such things must be created/destroyed by ButtonRegistry init/destroy fns.
 *
 * These run in `npm test` (vitest, no server) — the layer that was missing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const JS_ROOT = path.join(ROOT, 'resources/js');

// ---------------------------------------------------------------------------
// Allowlists — the ONLY approved exceptions. Adding an entry here is a conscious
// decision a reviewer sees in the diff, with a required justification comment.
// ---------------------------------------------------------------------------

// Non-component bootstrap scripts legitimately loaded directly by reader.blade.php's
// @vite. Anything NOT here is presumed an interactive component and must be registered.
const ALLOWED_READER_VITE_JS = new Set([
  'resources/js/components/utilities/containerCustomization.ts', // applies persisted container styles (no listeners)
  'resources/js/pageLoad/readerEntry.ts', // the reader bootstrap entry (imports app.js + viewManager)
]);

// Files permitted to self-instantiate a `window.X = new Y()` global singleton at module
// top level. Empty on purpose: today nothing does this, and nothing new should.
const ALLOWED_GLOBAL_SINGLETONS = new Set([]);

// Interactive components that MUST stay registered with ButtonRegistry. Removal (e.g. a
// refactor that drops the registration but leaves the feature) fails here loudly.
const REQUIRED_REGISTERED_COMPONENTS = [
  'containerDragger', // the resize/drag bug above — locked in
  'perimeterButtons',
  'editButton',
  'sourceButton',
  'toc',
  'footnoteCitationListeners',
  'footnoteTapExtender',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'archive') continue;
      out.push(...walkJsFiles(full));
    } else if (/\.(js|ts)$/.test(entry.name) && !/\.bak$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function readerViteJsEntries() {
  const blade = fs.readFileSync(path.join(ROOT, 'resources/views/reader.blade.php'), 'utf8');
  // Collect every quoted 'resources/js/....js' that appears inside an @vite([...]) call.
  const entries = new Set();
  const viteBlocks = blade.match(/@vite\(\[([\s\S]*?)\]\)/g) || [];
  for (const block of viteBlocks) {
    for (const m of block.matchAll(/'(resources\/js\/[^']+\.(?:js|ts))'/g)) {
      entries.add(m[1]);
    }
  }
  return [...entries];
}

function registeredComponentNames() {
  const src = fs.readFileSync(path.join(ROOT, 'resources/js/components/utilities/registerComponents.ts'), 'utf8');
  // Names inside `buttonRegistry.register({ name: '...' })`. Ignore commented-out lines.
  const names = new Set();
  for (const line of src.split('\n')) {
    if (line.trim().startsWith('//')) continue;
    const m = line.match(/name:\s*'([^']+)'/);
    if (m) names.add(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('interactive components go through ButtonRegistry', () => {
  it('reader.blade.php @vite loads only approved bootstraps — no component side-effects', () => {
    const offenders = readerViteJsEntries().filter((e) => !ALLOWED_READER_VITE_JS.has(e));
    expect(
      offenders,
      `reader.blade.php loads JS via @vite that isn't an approved bootstrap: ${JSON.stringify(offenders)}.\n` +
        `Interactive components must NOT be loaded as @vite side-effects — they won't re-init after\n` +
        `in-SPA navigation (the blade only renders on a full page load). Register the component in\n` +
        `resources/js/components/utilities/registerComponents.ts (ButtonRegistry, pages: ['reader']) instead.\n` +
        `If this genuinely is a non-component bootstrap, add it to ALLOWED_READER_VITE_JS with a reason.`,
    ).toEqual([]);
  });

  it('no module self-instantiates a global UI singleton (window.X = new Y()) at the top level', () => {
    const offenders = [];
    for (const file of walkJsFiles(JS_ROOT)) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED_GLOBAL_SINGLETONS.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        // Top-level only (no leading whitespace) — `window.foo = new Bar(` ...
        if (/^window\.[A-Za-z_$][\w$]*\s*=\s*new\s+[A-Za-z_$][\w$]*\s*\(/.test(line)) {
          offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `Self-instantiating global UI singleton(s) found:\n${offenders.join('\n')}\n` +
        `This is the drag.js smell — a singleton whose lifecycle nobody owns, so it never re-inits\n` +
        `after SPA navigation. Move creation into a ButtonRegistry init fn (see initContainerDragger\n` +
        `in components/containerDragger/containerDragger.ts + its registration in registerComponents.js).`,
    ).toEqual([]);
  });

  it('every required interactive component is registered with ButtonRegistry', () => {
    const registered = registeredComponentNames();
    const missing = REQUIRED_REGISTERED_COMPONENTS.filter((n) => !registered.has(n));
    expect(
      missing,
      `Interactive component(s) no longer registered in registerComponents.js: ${JSON.stringify(missing)}.\n` +
        `If a feature was removed, drop it from REQUIRED_REGISTERED_COMPONENTS too. If it was merely\n` +
        `un-registered by accident, it will be dead after SPA navigation — re-register it.`,
    ).toEqual([]);
  });
});
