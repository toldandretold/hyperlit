/**
 * GUARDRAIL: no NEW raw `console.*` calls in resources/js (a ratchet).
 *
 * The sanctioned logging system is resources/js/utilities/logger.ts (`log.*` for
 * always-shown checkpoints, `verbose.*` for flag-gated debugging). Raw console calls
 * bypass its production silencing and verbose gating, and unbounded console spam in
 * hot paths (scroll/mutation/observer callbacks) has actually hung the tab when
 * verbose mode was enabled. This counts raw `console.log/warn/error/info/debug/trace`
 * calls per top-level resources/js folder and fails if a folder EXCEEDS its committed
 * baseline (consoleBaseline.json).
 *
 * It is a RATCHET, not a freeze: counts may only go DOWN. When you remove console
 * calls the test prints the new (lower) count — copy it into consoleBaseline.json so
 * the gain is locked in. Raising a baseline number is a conscious decision a reviewer
 * sees in the diff.
 *
 * Scope note: utilities/logger.ts itself is excluded (its console calls ARE the
 * logger), as is archive/ (dead code). Commented-out console calls still count —
 * delete them rather than commenting out. Group-level totals (not per-file): moving a
 * call within a folder is allowed; adding one to the folder is not.
 *
 * Runs in `npm test` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.resolve(HERE, '../../..', 'resources/js');
const BASELINE_PATH = path.join(HERE, 'consoleBaseline.json');
const BASELINE = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

const CONSOLE_CALL = /\bconsole\.(log|warn|error|info|debug|trace)\s*\(/g;
const EXCLUDED_FILES = new Set([path.join(JS_ROOT, 'utilities/logger.ts')]);

function walkSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'archive') continue;
      out.push(...walkSourceFiles(full));
    } else if (/\.(js|ts)$/.test(entry.name) && !/\.bak$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function countConsoleInFile(file) {
  const matches = fs.readFileSync(file, 'utf8').match(CONSOLE_CALL);
  return matches ? matches.length : 0;
}

// Bucket every source file by its top-level folder under resources/js;
// files sitting directly in resources/js go under "(root)".
function currentCountsByFolder() {
  const counts = {};
  for (const file of walkSourceFiles(JS_ROOT)) {
    if (EXCLUDED_FILES.has(file)) continue;
    const rel = path.relative(JS_ROOT, file);
    const segments = rel.split(path.sep);
    const bucket = segments.length > 1 ? segments[0] : '(root)';
    counts[bucket] = (counts[bucket] || 0) + countConsoleInFile(file);
  }
  return counts;
}

const CURRENT = currentCountsByFolder();

function suggestedBaseline() {
  const entries = Object.entries(CURRENT)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

describe('no NEW raw console.* in resources/js (ratchet)', () => {
  const groups = Object.keys(BASELINE).filter((k) => !k.startsWith('_'));

  for (const rel of groups) {
    it(`${rel}: raw console.* count must not exceed its baseline (${BASELINE[rel]})`, () => {
      const current = CURRENT[rel] || 0;
      const baseline = BASELINE[rel];

      if (current < baseline) {
        // Ratchet nudge — lock in the reduction.
        console.warn(
          `[noNewConsole] ${rel}: ${current} raw console.* (baseline ${baseline}). ` +
          `Lower the baseline in consoleBaseline.json to ${current} to keep the ratchet tight.`
        );
      }

      expect(
        current,
        `${rel} introduced new raw console.* calls (${current} > baseline ${baseline}). ` +
        `Use \`log\`/\`verbose\` from resources/js/utilities/logger.ts, or delete the log.`
      ).toBeLessThanOrEqual(baseline);
    });
  }

  it('every folder with raw console.* calls has a baseline entry', () => {
    const missing = Object.entries(CURRENT)
      .filter(([bucket, count]) => count > 0 && !(bucket in BASELINE))
      .map(([bucket, count]) => `${bucket}: ${count}`);

    expect(
      missing,
      `Folders with raw console.* but no consoleBaseline.json entry: ${missing.join(', ')}. ` +
      `Add them (or better, route the logging through utilities/logger.ts). ` +
      `Full suggested baseline:\n${suggestedBaseline()}`
    ).toEqual([]);
  });
});
