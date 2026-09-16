/**
 * GUARDRAIL: every fetch() Response in resources/js must have its body consumed.
 *
 * An unconsumed Response body is not free. The browser keeps the request
 * in-flight and holds its connection open (HTTP/1.1 allows 6 per origin), and
 * Playwright never fires `requestfinished` for it — so a page carrying ONE
 * undrained response can NEVER reach network-idle. Consuming the body is what
 * releases it.
 *
 * This has shipped twice, which is why it is now a gate rather than a habit:
 *   - `utilities/auth/session.ts` threw on a 429 without reading the body
 *     (2026-09-08) — every rate-limited anon page load left a dangling socket.
 *   - `scrolling/pageViewTelemetry.ts` discarded a 401 on every home-page entry
 *     (2026-09-16) — ~30 e2e specs across unrelated folders timed out on
 *     `goto('/')` + `waitForLoadState('networkidle')`, and the cause looked
 *     like a divEditor/footnote bug for as long as it took to find it.
 *
 * The recurring shape: an endpoint whose NON-2xx branch is a ROUTINE outcome
 * (401 "no identity yet", 429 "slow down"), called by code that only cares
 * whether it worked. Note `if (res.ok)` does NOT drain — reading a status code
 * leaves the body untouched. Neither does `.catch(() => {})`.
 *
 * HOW TO FIX a failure here — any one of:
 *   - `await drainResponse(await fetch(url, opts))` — wraps in place and still
 *     returns the Response, so `.ok` / `.status` keep working.
 *   - `fetch(url, opts).then(drainResponse).catch(() => {})` for fire-and-forget.
 *   - Actually use the body: `.json()` / `.text()` / `.blob()` / `.arrayBuffer()`.
 * `drainResponse` lives in resources/js/utilities/drainResponse.ts.
 *
 * Scope: this is a zero-tolerance gate, not a ratchet — the codebase is at 0 and
 * a drain is always a one-line change, so there is no debt to pay down. It scans
 * comment/string-masked source, so `fetch()` written in prose does not count.
 * A `return fetch(...)` is the caller's responsibility and is not flagged, and
 * neither is a fetch inside an array literal (Promise.all), whose results are
 * consumed through the destructured bindings.
 *
 * Runs in `npm test` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findUndrainedFetches, maskCode } from './helpers/fetchDrainScan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const JS_ROOT = path.join(REPO_ROOT, 'resources/js');
const HELPER = path.join(JS_ROOT, 'utilities/drainResponse.ts');

/**
 * Deliberate, reviewed exceptions — `'path/to/file.ts:LINE'`. Empty on purpose:
 * adding an entry should require explaining in review why a held-open
 * connection is acceptable there.
 */
const ALLOWLIST = new Set([]);

describe('architecture: no undrained fetch responses', () => {
  it('every fetch() in resources/js consumes its Response body', () => {
    const findings = findUndrainedFetches(JS_ROOT, REPO_ROOT)
      .filter((f) => !ALLOWLIST.has(`${f.file}:${f.line}`));

    const report = findings.map((f) => `  ${f.file}:${f.line} — ${f.reason}`).join('\n');
    expect(
      findings,
      findings.length
        ? `Undrained fetch response(s) — the page can never reach network-idle.\n${report}\n\n`
          + 'Fix: wrap with drainResponse() from resources/js/utilities/drainResponse.ts, '
          + 'or consume the body (.json()/.text()/.blob()). Reading .ok does NOT drain.'
        : '',
    ).toEqual([]);
  });

  it('the drainResponse helper exists and actually consumes the body', () => {
    expect(fs.existsSync(HELPER), 'resources/js/utilities/drainResponse.ts is missing').toBe(true);
    const src = fs.readFileSync(HELPER, 'utf8');
    // It must READ the body, not cancel the stream: cancelling would abort the
    // transfer and break the prefetch callers that fetch purely to warm cache.
    expect(src).toMatch(/await\s+response\.(blob|text|arrayBuffer)\(\)/);
    expect(src).toMatch(/export\s+async\s+function\s+drainResponse/);
  });

  it('the scanner ignores fetch() written inside comments and strings', () => {
    // Guards the scan itself — an earlier version counted prose mentions of
    // fetch() and reported 15 phantom sites.
    const masked = maskCode([
      '// a comment mentioning fetch() should not count',
      'const help = "docs say fetch() returns a Response";',
      'const real = await fetch(url);',
    ].join('\n'));

    const hits = masked.match(/\bfetch\s*\(/g) || [];
    expect(hits).toHaveLength(1);
    // Masking must preserve offsets so reported line numbers stay correct.
    expect(masked.split('\n')).toHaveLength(3);
  });
});
