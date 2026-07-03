/**
 * css-cascade-snapshot.mjs — tier-1 regression gate for the CSS reorganization.
 *
 * The reorg (see resources/css/README.md) moves rules VERBATIM out of the legacy
 * mega-files (containers.css / buttons.css) into components/*.css, keeping the
 * resolved per-page cascade byte-identical. This script proves that: it resolves
 * every page entry's @import graph (depth-first, in order — exactly what the
 * browser/Vite does), normalizes away comments and whitespace (which cannot
 * affect the cascade), and diffs against a saved snapshot.
 *
 * Workflow per extraction session:
 *   node scripts/css-cascade-snapshot.mjs save      # before touching anything
 *   ... move a section verbatim, add its @import before the residual ...
 *   node scripts/css-cascade-snapshot.mjs compare   # must report OK per page
 *
 * One-off for the phase-1 rewiring (blade lists -> pages/*.css entries):
 *   node scripts/css-cascade-snapshot.mjs legacy-baseline && node scripts/css-cascade-snapshot.mjs compare
 * reconstructs the pre-reorg cascade from the OLD blade @vite lists (files mapped
 * to their moved locations) and checks the new page entries resolve identically.
 *
 * Snapshots live in .css-cascade-snapshots/ (gitignored — this is a migration
 * tool, not CI; the permanent gates are in tests/javascript/architecture/cssStructure.test.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CSS = path.join(ROOT, 'resources/css');
const SNAP_DIR = path.join(ROOT, '.css-cascade-snapshots');

// The page entries = what the blades @vite. app.css is included as its own "page"
// (every blade loads it as a separate link alongside its pages/*.css entry).
function pageEntries() {
  const pages = fs
    .readdirSync(path.join(CSS, 'pages'))
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => ['pages/' + f, path.join(CSS, 'pages', f)]);
  return [['app.css', path.join(CSS, 'app.css')], ...pages];
}

// Pre-reorg blade @vite lists (minus app.css, which was and is a separate link),
// with each old top-level file mapped to where it lives now. Used ONLY by the
// legacy-baseline command to prove the phase-1 rewiring preserved the cascade.
const LEGACY_LISTS = {
  'app.css': ['app.css'],
  'pages/reader.css': [
    'components/accountPage.css', // was reader.css
    'components/highlight-div.css',
    'containers.css',
    'buttons.css',
    'components/alert.css',
    'base/layout.css',
  ],
  'pages/home.css': [
    'components/accountPage.css',
    'components/highlight-div.css',
    'containers.css',
    'buttons.css',
    'components/form.css',
    'components/alert.css',
    'base/layout.css',
    'components/homepage.css',
  ],
  'pages/user.css': [
    'components/accountPage.css',
    'components/highlight-div.css',
    'containers.css',
    'buttons.css',
    'components/form.css',
    'components/alert.css',
    'base/layout.css',
  ],
  'pages/auth.css': ['containers.css', 'buttons.css', 'components/form.css'],
  'pages/user-home.css': ['base/layout.css'],
  'pages/quantizer.css': ['components/quantizer.css'],
};

// Matches @import "..." / @import url(...) with optional trailing layer()/media.
const IMPORT_RE = /@import\s+(?:url\(\s*)?['"]?([^'")]+)['"]?\s*\)?\s*([^;]*);/g;

/**
 * Depth-first inline of RELATIVE @imports, in source order — mirrors how the
 * browser (and Vite's build-time inlining) assembles the cascade. Imports that
 * are external / absolute / layer()-qualified are kept as literal lines: they
 * are outside the reorg's blast radius and must simply remain identical.
 */
function resolveFile(file, seenStack = []) {
  if (seenStack.includes(file)) {
    throw new Error(`@import cycle: ${[...seenStack, file].join(' -> ')}`);
  }
  // Strip comments BEFORE scanning: comments can't affect the cascade, may
  // contain the literal text "@import" (false match), and may contain
  // commented-out imports that must NOT be inlined.
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return src.replace(IMPORT_RE, (whole, target, qualifier) => {
    const isRelative = target.startsWith('./') || target.startsWith('../');
    const hasQualifier = qualifier.trim().length > 0; // layer(...), media query, ...
    if (!isRelative || hasQualifier) return whole;
    const resolved = path.resolve(path.dirname(file), target);
    return `\n${resolveFile(resolved, [...seenStack, file])}\n`;
  });
}

// Comments and whitespace cannot change the cascade; normalizing them out makes
// the diff robust to file-boundary comments added/removed by extractions.
function normalize(cssText) {
  return cssText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function snapPath(name) {
  return path.join(SNAP_DIR, name.replace(/[\/]/g, '__') + '.txt');
}

function save() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  for (const [name, file] of pageEntries()) {
    fs.writeFileSync(snapPath(name), normalize(resolveFile(file)));
    console.log(`saved   ${name}`);
  }
}

function legacyBaseline() {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  for (const [name, files] of Object.entries(LEGACY_LISTS)) {
    const text = files.map((f) => resolveFile(path.join(CSS, f))).join('\n');
    fs.writeFileSync(snapPath(name), normalize(text));
    console.log(`baselined ${name} (from pre-reorg blade list)`);
  }
}

function compare() {
  let failed = 0;
  for (const [name, file] of pageEntries()) {
    const snap = snapPath(name);
    if (!fs.existsSync(snap)) {
      console.log(`MISSING ${name} — run 'save' (or 'legacy-baseline') first`);
      failed++;
      continue;
    }
    const before = fs.readFileSync(snap, 'utf8');
    const after = normalize(resolveFile(file));
    if (before === after) {
      console.log(`OK      ${name}`);
    } else {
      failed++;
      // Locate the first divergence to give a usable pointer, not just a boolean.
      let i = 0;
      while (i < Math.min(before.length, after.length) && before[i] === after[i]) i++;
      console.log(`DIFF    ${name} (first divergence at normalized char ${i})`);
      console.log(`  baseline: …${before.slice(Math.max(0, i - 60), i + 120)}…`);
      console.log(`  current:  …${after.slice(Math.max(0, i - 60), i + 120)}…`);
    }
  }
  if (failed) {
    console.error(`\n${failed} page(s) diverged — the cascade CHANGED. Fix before proceeding.`);
    process.exit(1);
  }
  console.log('\nAll page cascades byte-identical (post-normalization).');
}

const cmd = process.argv[2];
if (cmd === 'save') save();
else if (cmd === 'compare') compare();
else if (cmd === 'legacy-baseline') legacyBaseline();
else {
  console.log('usage: node scripts/css-cascade-snapshot.mjs <save|compare|legacy-baseline>');
  process.exit(2);
}
