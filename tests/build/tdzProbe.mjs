/**
 * Production-bundle TDZ probe.
 *
 * Loads every built Vite entry chunk and runs its module-init under a DOM shim, asserting that
 * none throws `Cannot access X before initialization` — a circular-import Temporal Dead Zone
 * crash that only manifests in the ROLLUP-bundled output (module-init order), NOT in vitest
 * (different loader) and NOT in the flow-viz no-cycle gate (which only scans select folders, so
 * a cycle through e.g. utilities/ is invisible to it). This class of bug took prod down once
 * (`Cannot access 'Sm' before initialization`); this guard is the net for it.
 *
 * Usage: `npm run build` first (or use `npm run test:tdz`, which builds then runs this).
 * Exits non-zero if any entry TDZ-crashes at init.
 */
import { Window } from 'happy-dom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(REPO, 'public/build/manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('No build manifest — run `npm run build` first.');
  process.exit(2);
}

// DOM + script-tag-global shims so module-init can run headlessly. A deep no-op Proxy stands in
// for libs the blade loads via <script> (rangy/CryptoJS/katex) — their methods are called at
// init but their identity doesn't matter for a TDZ check.
const w = new Window({ url: 'https://hyperlit.io/book_probe' });
globalThis.window = w;
globalThis.document = w.document;
for (const k of ['navigator', 'location', 'localStorage', 'sessionStorage', 'history', 'CustomEvent', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'IntersectionObserver', 'getSelection']) {
  try { if (globalThis[k] === undefined) globalThis[k] = w[k]; } catch { /* ignore */ }
}
globalThis.requestIdleCallback = (fn) => setTimeout(fn, 0);
const noop = () => undefined;
const deep = new Proxy(noop, { get: () => deep, apply: () => deep, construct: () => deep });
globalThis.rangy = deep; globalThis.CryptoJS = deep; globalThis.katex = deep;
w.rangy = deep;

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entries = Object.values(manifest)
  .filter((e) => e.isEntry && /\.js$/.test(e.file))
  .map((e) => e.file);

let tdz = 0;
for (const file of entries) {
  try {
    await import(path.join(REPO, 'public/build', file));
    // module-init OK
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/before initialization/i.test(msg)) {
      console.error(`✗ TDZ in ${file}: ${msg}`);
      tdz++;
    }
    // Non-TDZ init errors (missing browser globals the shim doesn't cover) are ignored — this
    // probe only asserts the absence of circular-import TDZ crashes.
  }
}

if (tdz) {
  console.error(`\n${tdz} entry chunk(s) crash at module-init with a circular-import TDZ.`);
  process.exit(1);
}
console.log(`✓ TDZ probe: ${entries.length} entry chunks init cleanly (no circular-import TDZ).`);
