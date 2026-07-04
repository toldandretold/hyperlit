/**
 * Merge the per-state a11y scan reports written by helpers/a11y.js into one
 * ranked summary + a ready-to-paste ratchet baseline.
 *
 * Usage: node tests/e2e/scripts/merge-a11y-report.mjs
 *
 * Reads  tests/e2e/test-results/a11y/*.json  (from the last `npm run test:a11y`),
 * writes summary.json alongside them, and prints:
 *   - totals by axe impact (critical / serious / moderate / minor),
 *   - a per-rule table (impact, WCAG tags, states affected, total nodes, help),
 *   - the a11yBaseline.json blob to paste into specs/a11y/a11yBaseline.json.
 *
 * `-retry` scan files (written by the spec's anti-flake re-scan) are ignored so
 * a state isn't double-counted.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const A11Y_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'test-results', 'a11y'
);

let files;
try {
  files = readdirSync(A11Y_DIR).filter(
    (f) => f.endsWith('.json') && f !== 'summary.json' && !/-retry\.json$/.test(f)
  );
} catch {
  console.error(`No a11y reports found — ${A11Y_DIR} does not exist. Run \`npm run test:a11y\` first.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No per-state reports in ${A11Y_DIR}. Run \`npm run test:a11y\` first.`);
  process.exit(1);
}

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3, null: 4 };

const states = [];                 // { label, url, wcagNodes, bestPracticeNodes }
const byRule = new Map();          // ruleId -> aggregate
const baseline = {};               // label -> { ruleId: nodeCount }  (WCAG only)
const totalsByImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };

for (const f of files) {
  const report = JSON.parse(readFileSync(join(A11Y_DIR, f), 'utf8'));
  const { label, url, violations } = report;
  let wcagNodes = 0, bpNodes = 0;
  for (const v of violations) {
    if (v.bestPracticeOnly) { bpNodes += v.nodes; continue; }
    wcagNodes += v.nodes;
    if (v.impact in totalsByImpact) totalsByImpact[v.impact] += v.nodes;

    baseline[label] = baseline[label] || {};
    baseline[label][v.ruleId] = (baseline[label][v.ruleId] || 0) + v.nodes;

    const agg = byRule.get(v.ruleId) || {
      ruleId: v.ruleId, impact: v.impact, wcag: v.wcag,
      help: v.help, helpUrl: v.helpUrl, totalNodes: 0, states: new Set(),
    };
    agg.totalNodes += v.nodes;
    agg.states.add(label);
    byRule.set(v.ruleId, agg);
  }
  states.push({ label, url, wcagNodes, bestPracticeNodes: bpNodes });
}

const rules = [...byRule.values()]
  .map((r) => ({ ...r, states: [...r.states].sort() }))
  .sort((a, b) =>
    (IMPACT_ORDER[a.impact] ?? 4) - (IMPACT_ORDER[b.impact] ?? 4) ||
    b.totalNodes - a.totalNodes
  );

// Sort baseline keys for a stable, paste-ready blob.
const sortedBaseline = {};
for (const label of Object.keys(baseline).sort()) {
  const sortedRules = {};
  for (const rule of Object.keys(baseline[label]).sort()) sortedRules[rule] = baseline[label][rule];
  sortedBaseline[label] = sortedRules;
}

const summary = {
  generatedFrom: files.length,
  states: states.sort((a, b) => a.label.localeCompare(b.label)),
  totalsByImpact,
  totalWcagNodes: Object.values(totalsByImpact).reduce((a, b) => a + b, 0),
  rules,
  suggestedBaseline: sortedBaseline,
};
writeFileSync(join(A11Y_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

/* ── console report ───────────────────────────────────────────────────── */
console.log(`\nAccessibility scan summary — ${states.length} page-state(s), WCAG 2.2 AA`);
console.log('='.repeat(72));
console.log('Violations by impact (node count):');
for (const [impact, n] of Object.entries(totalsByImpact)) {
  console.log(`  ${impact.padEnd(9)} ${n}`);
}
console.log(`  ${'TOTAL'.padEnd(9)} ${summary.totalWcagNodes} WCAG-A/AA violation nodes\n`);

console.log('Per-state:');
console.log('  STATE                        WCAG  best-practice');
for (const s of summary.states) {
  console.log(`  ${s.label.padEnd(28)} ${String(s.wcagNodes).padStart(4)}  ${String(s.bestPracticeNodes).padStart(4)}`);
}

console.log('\nRules (most severe first):');
console.log('  IMPACT     NODES  RULE                          STATES');
for (const r of rules) {
  console.log(
    `  ${String(r.impact).padEnd(9)} ${String(r.totalNodes).padStart(5)}  ${r.ruleId.padEnd(28)}  ${r.states.join(', ')}`
  );
  console.log(`             ${r.help}  [${r.wcag.join(', ')}]`);
}

console.log('\n' + '='.repeat(72));
console.log('Paste into tests/e2e/specs/a11y/a11yBaseline.json to lock the ratchet:');
console.log(JSON.stringify(sortedBaseline, null, 2));
console.log(`\nFull machine summary: ${join(A11Y_DIR, 'summary.json')}`);
