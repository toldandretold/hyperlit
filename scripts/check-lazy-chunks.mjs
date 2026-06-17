/**
 * Bundle-regression gate: asserts the edit/feature folders stay OUT of the reader's EAGER bundle.
 *
 * The reader-init download must NOT contain divEditor / editToolbar / hyperlights / hypercites / the
 * heavy paste system — those are lazy (loaded on edit-mode / reader-init). This test FAILS the moment
 * someone re-introduces a static import that pins one of them eager again (the exact regression we
 * fought), and names the offending module + the eager chunk that pulled it in. Plus a loose eager-byte
 * ceiling to catch gross bloat.
 *
 * Run: `npm run gate:bundle`  (= BUNDLE_GATE=1 vite build && node scripts/check-lazy-chunks.mjs)
 * Needs public/build/manifest.json + public/build/chunkmap.json (the latter emitted only when
 * BUNDLE_GATE=1). Deterministic, no server.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'public/build');
const MANIFEST = path.join(BUILD, 'manifest.json');
const CHUNKMAP = path.join(BUILD, 'chunkmap.json');

// The reader page loads the most — its eager closure is the superset to guard.
const ENTRIES = [
  'resources/js/app.js',
  'resources/js/components/utilities/containerCustomization.ts',
  'resources/js/pageLoad/readerEntry.ts',
];

// Modules that MUST NOT appear in the eager set. Heavy paste is forbidden; the eager-reachable paste
// leaves (state/utils/undo-toast, intentionally shared with eager code) are exempt.
const FORBIDDEN = [/^resources\/js\/divEditor\//, /^resources\/js\/editToolbar\//, /^resources\/js\/hyperlights\//, /^resources\/js\/hypercites\//, /^resources\/js\/paste\//];
const PASTE_EXEMPT = [/\/paste\/pasteState/, /\/paste\/pasteSnapshot/, /\/paste\/utils\//, /\/paste\/ui\//];
const EAGER_CEILING_KB = 650; // gross-bloat ceiling (measured ~554); not a tight budget.

function fail(msg) { console.error(`\n❌ bundle gate FAILED:\n${msg}\n`); process.exit(1); }

if (!fs.existsSync(MANIFEST)) fail(`${path.relative(ROOT, MANIFEST)} missing — run \`npm run build\` first.`);
if (!fs.existsSync(CHUNKMAP)) fail(`${path.relative(ROOT, CHUNKMAP)} missing — run via \`npm run gate:bundle\` (sets BUNDLE_GATE=1).`);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const chunkmap = JSON.parse(fs.readFileSync(CHUNKMAP, 'utf8'));

// Resolve each entry to its built chunk file, then BFS the STATIC `imports` graph (chunkmap) = eager set.
const entryFiles = ENTRIES.map((e) => manifest[e]?.file).filter(Boolean);
if (entryFiles.length !== ENTRIES.length) fail(`some entries missing from manifest: ${ENTRIES.filter((e) => !manifest[e]).join(', ')}`);

const eager = new Set();
const queue = [...entryFiles];
while (queue.length) {
  const f = queue.shift();
  if (eager.has(f)) continue;
  eager.add(f);
  for (const imp of chunkmap[f]?.imports || []) queue.push(imp);
}

// Collect eager modules + check forbidden.
const offenders = [];
let eagerBytes = 0;
for (const f of eager) {
  const abs = path.join(BUILD, f);
  if (fs.existsSync(abs)) eagerBytes += fs.statSync(abs).size;
  for (const m of chunkmap[f]?.modules || []) {
    if (m.includes('/node_modules/')) continue;
    const forbidden = FORBIDDEN.some((re) => re.test(m)) && !PASTE_EXEMPT.some((re) => re.test(m));
    if (forbidden) offenders.push({ module: m, chunk: f });
  }
}

const eagerKB = +(eagerBytes / 1024).toFixed(1);
console.log(`\n📦 reader eager: ${eager.size} chunks, ${eagerKB} kB raw`);

if (offenders.length) {
  const lines = offenders.map((o) => `   ${o.module}\n      └─ pulled into eager chunk: ${o.chunk}`).join('\n');
  fail(`${offenders.length} edit/feature module(s) leaked into the EAGER reader bundle (they must be lazy —\nsome eager module added a static import of them; convert it to a reader-gated/edit-gated \`await import()\`):\n${lines}`);
}
if (eagerKB > EAGER_CEILING_KB) {
  fail(`reader eager ${eagerKB} kB exceeds the ${EAGER_CEILING_KB} kB ceiling — gross bundle bloat. Investigate with \`npm run measure:bundle\`.`);
}

console.log(`✅ bundle gate PASSED: no divEditor/editToolbar/hyperlights/hypercites/heavy-paste modules in the eager set; eager ≤ ${EAGER_CEILING_KB} kB.\n`);
