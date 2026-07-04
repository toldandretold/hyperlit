/**
 * Accessibility (a11y) scanning helper.
 *
 * Wraps @axe-core/playwright to run WCAG 2.2 Level AA checks against a page in
 * a specific interaction state, writes a per-state JSON report under
 * tests/e2e/test-results/a11y/, and provides the ratchet-baseline diff used by
 * specs/a11y/axe-scan.spec.js.
 *
 * Design notes:
 *   - Axe deterministically catches only ~30-50% of WCAG issues (contrast,
 *     names, roles, structure). The operability half (keyboard, focus) lives in
 *     specs/a11y/keyboard.spec.js.
 *   - The ratchet mirrors tests/javascript/architecture/noNewConsole.test.js:
 *     violation-node counts per page-state per rule may only go DOWN. A new rule
 *     in a known state, or a count above baseline, fails; an improvement warns
 *     with the suggested lower baseline.
 *   - Granularity is per-state + per-rule node COUNT (not per-CSS-selector) —
 *     selectors shift with content on a dynamic SPA and would flake.
 */

import { AxeBuilder } from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const A11Y_RESULTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'test-results', 'a11y'
);

/**
 * WCAG 2.2 Level AA tag set. These are the tags that count toward the ratchet.
 * `best-practice` is scanned and reported too (see a11yScan) but is EXCLUDED
 * from the baseline so the gate stays tied to the published standard.
 */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Selectors axe should NOT blame the app for — third-party iframes and
 * dev-only chrome that isn't part of the shipped UI.
 */
const DEFAULT_EXCLUDES = [
  'iframe[src*="stripe"]',
  'iframe[src*="js.stripe"]',
  'vite-error-overlay',
  '#vite-error-overlay',
];

/**
 * Run an axe scan against the current page state and persist a normalized
 * report. Returns the normalized violations array (also written to disk).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} label            page-state label, e.g. 'reader-edit-mode'
 * @param {object} [opts]
 * @param {string[]} [opts.exclude]      extra CSS selectors to exclude
 * @param {string[]} [opts.disableRules] axe rule ids to disable for this state
 */
export async function a11yScan(page, label, { exclude = [], disableRules = [] } = {}) {
  const buildAndAnalyze = async () => {
    let builder = new AxeBuilder({ page })
      .withTags([...WCAG_TAGS, 'best-practice']);
    if (disableRules.length) builder = builder.disableRules(disableRules);
    for (const sel of [...DEFAULT_EXCLUDES, ...exclude]) builder = builder.exclude(sel);
    return builder.analyze();
  };

  // Axe injects a script and evaluates in-page; if the page navigates or loads
  // a deferred chunk mid-analyze the execution context is destroyed. Settle and
  // retry once before giving up.
  let results;
  try {
    results = await buildAndAnalyze();
  } catch (e) {
    if (/context was destroyed|Execution context|navigation/i.test(e.message || '')) {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(500);
      results = await buildAndAnalyze();
    } else {
      throw e;
    }
  }

  const violations = results.violations.map((v) => {
    const wcag = v.tags.filter((t) => /^wcag\d/.test(t));
    return {
      ruleId: v.id,
      impact: v.impact, // critical | serious | moderate | minor
      wcag, // e.g. ['wcag2aa', 'wcag143']
      bestPracticeOnly: wcag.length === 0,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.length,
      sampleTargets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    };
  });

  mkdirSync(A11Y_RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(A11Y_RESULTS_DIR, `${safeLabel(label)}.json`),
    JSON.stringify(
      { label, url: page.url(), scannedAt: new Date().toISOString(), violations },
      null, 2
    )
  );
  return violations;
}

function safeLabel(label) {
  return String(label).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * Collapse a normalized violations array to the ratchet shape:
 * { ruleId: totalNodeCount } — WCAG rows only (best-practice excluded).
 */
export function violationsToCounts(violations) {
  const counts = {};
  for (const v of violations) {
    if (v.bestPracticeOnly) continue;
    counts[v.ruleId] = (counts[v.ruleId] || 0) + v.nodes;
  }
  return counts;
}

/**
 * Diff the current per-rule counts for one state against its baseline entry.
 *
 * Rules (mirrors noNewConsole):
 *   - a rule present now with NO baseline entry  → failure (regression)
 *   - a rule whose count EXCEEDS its baseline     → failure
 *   - a rule whose count is BELOW its baseline    → improvement
 *   - a baselined rule now absent (count 0)       → improvement (fixed)
 *
 * @param {Record<string, number>} counts        violationsToCounts(...) output
 * @param {Record<string, number>|undefined} stateBaseline  baseline[label]
 * @returns {{ failures: string[], improvements: string[], known: boolean }}
 *   `known` is false when the state has no baseline object at all — callers
 *   treat that as report-only (bootstrap: seed the baseline from the printout).
 */
export function diffAgainstBaseline(counts, stateBaseline) {
  if (stateBaseline === undefined) {
    return { failures: [], improvements: [], known: false };
  }
  const failures = [];
  const improvements = [];
  for (const [rule, n] of Object.entries(counts)) {
    const base = stateBaseline[rule];
    if (base === undefined) {
      failures.push(`NEW rule "${rule}": ${n} node(s) — no baseline entry`);
    } else if (n > base) {
      failures.push(`"${rule}": ${n} node(s) > baseline ${base}`);
    } else if (n < base) {
      improvements.push(`"${rule}": ${n} < baseline ${base}`);
    }
  }
  for (const rule of Object.keys(stateBaseline)) {
    if (!(rule in counts)) {
      improvements.push(`"${rule}": 0 < baseline ${stateBaseline[rule]} (fixed!)`);
    }
  }
  return { failures, improvements, known: true };
}
