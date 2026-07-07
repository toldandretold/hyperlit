/**
 * GUARDRAIL: the saved reading position is read ONLY via scrolling/readingAnchor.ts.
 *
 * The reading-position system saves the topmost visible node to
 * `scrollPosition_<bookId>` storage from a 250ms-throttled scroll handler.
 * Consumers that hand-parse that storage (each with its own fallback rules)
 * and assume it is CURRENT are exactly how the audio player came to start
 * books from the top: the saved value lags the real position by up to one
 * throttle tick. The accessor (`getSavedAnchor` / `getFreshAnchor`) is the
 * single parse + the single place the staleness contract is documented —
 * `getFreshAnchor` re-runs the detector synchronously for "act on where the
 * user is RIGHT NOW" features (audio start, search open, caret placement,
 * TOC bookmark).
 *
 * This test fails when a file outside the allowlist mentions the
 * `scrollPosition` storage key. New consumers must import the accessor;
 * additions to the allowlist are a deliberate, reviewed exception (the
 * writer, the restore path, and the navigation system's own key writes).
 *
 * Runs in `npm test` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.resolve(HERE, '../../..', 'resources/js');

// Any construction/mention of the storage key: 'scrollPosition' as the
// getLocalStorageKey base, or the literal `scrollPosition_` prefix.
const KEY_LITERAL = /scrollPosition/;

// Files that legitimately touch the key (relative to resources/js):
const ALLOWLIST = new Set([
  // THE accessor — the only sanctioned read path for consumers.
  'scrolling/readingAnchor.ts',
  // The writer (the detector itself) + its beforeunload beacon read.
  'lazyLoader/index.ts',
  // The restore path (reads the anchor to scroll on book open).
  'scrolling/restore.ts',
  // Seeds the anchor from the server bookmark on initial load.
  'pageLoad/loadHyperText.ts',
  // Navigation system: writes/clears the key around its own transitions.
  'scrolling/internalNav.ts',
  'hypercites/navigation.ts',
  'SPA/navigation/LinkNavigationHandler.ts',
  'SPA/navigation/pathways/BookToBookTransition.ts',
  'SPA/navigation/resolveTargetChunk.ts',
]);

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

describe('saved reading position is read only via scrolling/readingAnchor.ts', () => {
  it('no file outside the allowlist touches the scrollPosition storage key', () => {
    const offenders = [];
    for (const file of walkSourceFiles(JS_ROOT)) {
      const rel = path.relative(JS_ROOT, file).split(path.sep).join('/');
      if (ALLOWLIST.has(rel)) continue;
      if (KEY_LITERAL.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
    }
    expect(
      offenders,
      `These files touch scrollPosition storage directly. Read the anchor via `
      + `getSavedAnchor()/getFreshAnchor() from resources/js/scrolling/readingAnchor.ts `
      + `instead (getFreshAnchor for anything acting on the CURRENT position — the raw `
      + `saved value lags by up to 250ms). If a file genuinely needs to write/clear the `
      + `key (navigation/restore machinery), add it to the allowlist in this test as a `
      + `reviewed exception.\nOffenders:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('allowlist entries still exist (no stale entries)', () => {
    const stale = [...ALLOWLIST].filter((rel) => !fs.existsSync(path.join(JS_ROOT, rel)));
    expect(stale, `Stale allowlist entries (file moved/deleted — update this test): ${stale.join(', ')}`).toEqual([]);
  });
});
