/**
 * GUARDRAIL: no NEW `: any` in the type-tightened folders (a ratchet).
 *
 * The editor write-path folders (divEditor / editToolbar / paste / components/editButton)
 * plus the id-vocabulary leaf (utilities/idHelpers.ts) were deliberately tightened. `any`
 * silently disables every downstream check, so without a gate the tightening erodes the
 * moment someone adds `x: any` back. This counts `: any` type annotations per folder and
 * fails if a folder EXCEEDS its committed baseline (anyBaseline.json).
 *
 * It is a RATCHET, not a freeze: counts may only go DOWN. When you remove anys the test
 * prints the new (lower) count — copy it into anyBaseline.json so the gain is locked in.
 * Raising a baseline number is a conscious decision a reviewer sees in the diff.
 *
 * Scope note: this counts the `: any` annotation form only (NOT `as any` casts, NOT
 * `<any>` / `Record<…, any>` generics). Group-level totals (not per-file) — moving an any
 * within a folder is allowed; adding one to the folder is not.
 *
 * Runs in `npm test` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BASELINE = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'anyBaseline.json'), 'utf8')
);

const ANY_ANNOTATION = /:\s*any\b/g;

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

function countAnyInFile(file) {
  const matches = fs.readFileSync(file, 'utf8').match(ANY_ANNOTATION);
  return matches ? matches.length : 0;
}

function countAnyInGroup(rel) {
  const target = path.join(ROOT, rel);
  const files = fs.statSync(target).isDirectory() ? walkSourceFiles(target) : [target];
  return files.reduce((sum, f) => sum + countAnyInFile(f), 0);
}

describe('no NEW `: any` in the type-tightened folders (ratchet)', () => {
  // Every baseline group (skip the `_comment` key).
  const groups = Object.keys(BASELINE).filter((k) => !k.startsWith('_'));

  for (const rel of groups) {
    it(`${rel}: \`: any\` count must not exceed its baseline (${BASELINE[rel]})`, () => {
      const current = countAnyInGroup(rel);
      const baseline = BASELINE[rel];

      if (current < baseline) {
        // Ratchet nudge — lock in the reduction.
        console.warn(
          `[noNewAny] ${rel}: ${current} \`: any\` (baseline ${baseline}). ` +
          `Lower the baseline in anyBaseline.json to ${current} to keep the ratchet tight.`
        );
      }

      expect(
        current,
        `${rel} introduced new \`: any\` (${current} > baseline ${baseline}). ` +
        `Type it properly instead of using \`any\` — see the type-tightening roadmap.`
      ).toBeLessThanOrEqual(baseline);
    });
  }
});
