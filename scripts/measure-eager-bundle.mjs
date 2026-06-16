/**
 * measure-eager-bundle.mjs — deterministic, no-server measurement of how much JS each page
 * type downloads EAGERLY on initial load, computed from the Vite build manifest.
 *
 * How it works: each page's blade `@vite([...])` declares its JS entry chunk(s). The manifest
 * records, per chunk, its static `imports` (fetched eagerly with the chunk) and `dynamicImports`
 * (separate lazy chunks, fetched only when `import()` runs). We BFS the STATIC `imports` graph
 * from each page's entries — that transitive closure is exactly what the browser downloads before
 * the page is interactive. `dynamicImports` are lazy *boundaries*: counted as lazy, not traversed.
 *
 * We then sum the on-disk size (raw + gzip) of the eager chunk files and report per page, plus
 * which feature chunks (editor / paste-system / highlights / divEditor / editToolbar) are eager vs
 * lazy — the whole point of the lazy-chunking work.
 *
 *   node scripts/measure-eager-bundle.mjs            # report + diff vs committed baseline
 *   node scripts/measure-eager-bundle.mjs --write    # update tests/performance/bundle-baseline.json
 *   npm run measure:bundle                           # vite build && this
 *
 * Run AFTER a production build (`npm run build`) so public/build/manifest.json is current.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'public/build');
const MANIFEST = path.join(BUILD, 'manifest.json');
const BASELINE = path.join(ROOT, 'tests/performance/bundle-baseline.json');

// Page → the JS entries its blade template loads via @vite([...]).
// reader.blade.php:421, home.blade.php:232, user.blade.php:219 (see plan / blade @vite directives).
const PAGES = {
  reader: ['resources/js/components/utilities/containerCustomization.ts', 'resources/js/pageLoad/readerEntry.ts'],
  home: ['resources/js/pageLoad/readerEntry.ts'],
  user: ['resources/js/pageLoad/readerEntry.ts'],
};

// Feature chunks we expect to be LAZY after the optimisation. Matched against chunk file basenames.
const FEATURE_PATTERNS = ['editor', 'paste-system', 'highlights', 'divEditor', 'editToolbar', 'hyperlights', 'hypercites'];

if (!fs.existsSync(MANIFEST)) {
  console.error(`✗ ${path.relative(ROOT, MANIFEST)} missing — run \`npm run build\` first.`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

const sizeCache = new Map();
function chunkSize(file) {
  if (sizeCache.has(file)) return sizeCache.get(file);
  const abs = path.join(BUILD, file);
  let raw = 0, gz = 0;
  if (fs.existsSync(abs)) {
    const buf = fs.readFileSync(abs);
    raw = buf.length;
    gz = zlib.gzipSync(buf).length;
  }
  const v = { raw, gz };
  sizeCache.set(file, v);
  return v;
}

// Resolve a manifest key (src path OR chunk file) to its manifest record.
const byFile = new Map();
for (const rec of Object.values(manifest)) if (rec.file) byFile.set(rec.file, rec);
function recOf(key) {
  return manifest[key] || byFile.get(key) || null;
}

/** BFS the static `imports` closure of a set of entry keys. Returns the set of eager chunk files. */
function eagerClosure(entries) {
  const seen = new Set();
  const eagerFiles = new Set();
  const queue = [...entries];
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = recOf(key);
    if (!rec) continue;
    if (rec.file && rec.file.endsWith('.js')) eagerFiles.add(rec.file);
    for (const imp of rec.imports || []) queue.push(imp); // static only — do NOT traverse dynamicImports
  }
  return eagerFiles;
}

const allJsChunks = new Set(Object.values(manifest).filter(r => r.file?.endsWith('.js')).map(r => r.file));

function classifyFeatures(eagerFiles) {
  const out = {};
  for (const pat of FEATURE_PATTERNS) {
    const matches = [...allJsChunks].filter(f => path.basename(f).startsWith(pat + '-') || path.basename(f).startsWith('_' + pat + '-'));
    if (!matches.length) continue;
    out[pat] = matches.map(f => ({ file: f, eager: eagerFiles.has(f), kb: +(chunkSize(f).raw / 1024).toFixed(1) }));
  }
  return out;
}

// Reverse map: chunk file → human label (manifest src/name if known, else the filename).
const fileLabel = new Map();
for (const [key, rec] of Object.entries(manifest)) {
  if (rec.file && !fileLabel.has(rec.file)) fileLabel.set(rec.file, rec.src || rec.name || key);
}

const report = { pages: {}, features: {} };
let readerEager = null;
for (const [page, entries] of Object.entries(PAGES)) {
  const eager = eagerClosure(entries);
  let raw = 0, gz = 0;
  for (const f of eager) { const s = chunkSize(f); raw += s.raw; gz += s.gz; }
  report.pages[page] = {
    eagerChunks: eager.size,
    eagerKB: +(raw / 1024).toFixed(1),
    eagerGzipKB: +(gz / 1024).toFixed(1),
  };
  if (page === 'reader') { report.features = classifyFeatures(eager); readerEager = eager; }
}

// ---- print ----
const fmt = (n) => `${n.toFixed(1)} kB`.padStart(11);
console.log('\n📦 Eager initial-load JS per page (from build manifest)\n');
console.log('  page     chunks    raw        gzip');
for (const [page, p] of Object.entries(report.pages)) {
  console.log(`  ${page.padEnd(8)} ${String(p.eagerChunks).padStart(4)}   ${fmt(p.eagerKB)} ${fmt(p.eagerGzipKB)}`);
}
console.log('\n🔍 Feature chunks (reader page) — want these LAZY:');
for (const [pat, chunks] of Object.entries(report.features)) {
  for (const c of chunks) {
    console.log(`  ${c.eager ? '❌ EAGER' : '✅ lazy '}  ${pat.padEnd(13)} ${c.file}  (${c.kb} kB)`);
  }
}

console.log('\n🏋️  Top 15 eager chunks on the reader page (where the bytes live):');
const topEager = [...readerEager]
  .map(f => ({ f, kb: chunkSize(f).raw / 1024, label: fileLabel.get(f) || f }))
  .sort((a, b) => b.kb - a.kb)
  .slice(0, 15);
for (const c of topEager) {
  console.log(`  ${c.kb.toFixed(1).padStart(8)} kB  ${c.label}`);
}

// ---- baseline diff / write ----
const write = process.argv.includes('--write');
if (write) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n💾 baseline written → ${path.relative(ROOT, BASELINE)}`);
} else if (fs.existsSync(BASELINE)) {
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  console.log('\n📈 vs baseline (reader eager raw):');
  for (const page of Object.keys(PAGES)) {
    const now = report.pages[page]?.eagerKB ?? 0;
    const was = base.pages?.[page]?.eagerKB ?? 0;
    const d = +(now - was).toFixed(1);
    console.log(`  ${page.padEnd(8)} ${was.toFixed(1)} → ${now.toFixed(1)} kB  (${d <= 0 ? '' : '+'}${d} kB)`);
  }
} else {
  console.log('\n(no baseline yet — run with --write to create tests/performance/bundle-baseline.json)');
}
