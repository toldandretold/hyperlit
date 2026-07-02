/**
 * Merge the per-test console-audit reports written by the shared e2e fixture
 * (tests/e2e/fixtures/navigation.fixture.js) into one frequency-ranked view.
 *
 * Usage: node tests/e2e/scripts/merge-console-audit.mjs
 *
 * Reads  tests/e2e/test-results/console-audit/*.json  (from the last e2e run),
 * merges by `type|file:line` (summing counts, keeping the first sample),
 * writes merged.json alongside them, and prints the top 50 sites.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'test-results', 'console-audit'
);

let files;
try {
  files = readdirSync(AUDIT_DIR).filter(f => f.endsWith('.json') && f !== 'merged.json');
} catch {
  console.error(`No audit reports found — ${AUDIT_DIR} does not exist. Run the e2e suite first.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No per-test reports in ${AUDIT_DIR}. Run the e2e suite first.`);
  process.exit(1);
}

const merged = new Map();
const tests = [];
for (const f of files) {
  const report = JSON.parse(readFileSync(join(AUDIT_DIR, f), 'utf8'));
  tests.push(report.test);
  for (const site of report.sites) {
    const key = `${site.type}|${site.file}:${site.line}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += site.count;
    } else {
      merged.set(key, { ...site });
    }
  }
}

const sites = [...merged.values()].sort((a, b) => b.count - a.count);
const byType = {};
let total = 0;
for (const site of sites) {
  byType[site.type] = (byType[site.type] || 0) + site.count;
  total += site.count;
}

const out = { mergedFrom: tests.length, totals: { total, byType }, sites };
writeFileSync(join(AUDIT_DIR, 'merged.json'), JSON.stringify(out, null, 2));

console.log(`Merged ${files.length} report(s): ${total} console messages from ${sites.length} unique sites.`);
console.log(`By type: ${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join('  ')}`);
console.log(`Full merged report: ${join(AUDIT_DIR, 'merged.json')}\n`);
console.log('Top 50 sites by frequency:');
console.log('COUNT  TYPE     LOCATION');
for (const site of sites.slice(0, 50)) {
  const loc = `${site.file}:${site.line}`;
  console.log(
    `${String(site.count).padStart(5)}  ${site.type.padEnd(7)}  ${loc}\n` +
    `       ${site.sample.split('\n')[0].slice(0, 110)}`
  );
}
