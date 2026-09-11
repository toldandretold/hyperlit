/**
 * GUARDRAIL: the `pending_new_book_sync` marker is touched ONLY through
 * utilities/pendingNewBook.ts.
 *
 * A book is created optimistically — written to IndexedDB and opened in the
 * reader before the server knows it exists — and this sessionStorage record is
 * the RELOAD-SURVIVING half of "the server doesn't have it yet" (the in-flight
 * half is utilities/newBookEstablished). Its value is the whole create payload,
 * because readerEntry re-sends it if the user refreshes mid-create.
 *
 * It used to be read in nine places, each with its own inline
 * `JSON.parse(sessionStorage.getItem(...))` and its own try/catch, and by two
 * DIFFERENT questions at once: "is it on the server yet" (the sync one) and
 * "should I show a loading overlay" (a presentation one that merely correlates).
 * That coupling is why clearing it meant two things at the same time. The
 * presentation callers now ask navigation/localContentEntry instead.
 *
 * The failure mode this prevents: a leaked/mis-cleared marker means a book is
 * treated as not-on-the-server FOREVER — silently disabling its optimistic
 * concurrency (409) protection. The import side already shipped that bug with
 * its own overlay flag (see viewManager's `pending_import_book` clear site).
 *
 * Runs in `npm test` (vitest, no server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.resolve(HERE, '../../..', 'resources/js');

const KEY = 'pending_new_book_sync';

// The accessor owns the key. Everything else imports its helpers.
const ALLOWLIST = new Set(['utilities/pendingNewBook.ts']);

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

/** Lines that USE the key, ignoring prose mentions in comments. */
function codeLinesTouchingKey(source) {
  return source.split('\n').filter((line) => {
    if (!line.includes(KEY)) return false;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
    return true;
  });
}

describe('pending_new_book_sync is touched only via utilities/pendingNewBook.ts', () => {
  it('no file outside the allowlist reads or writes the marker directly', () => {
    const offenders = [];
    for (const file of walkSourceFiles(JS_ROOT)) {
      const rel = path.relative(JS_ROOT, file).split(path.sep).join('/');
      if (ALLOWLIST.has(rel)) continue;
      const hits = codeLinesTouchingKey(fs.readFileSync(file, 'utf8'));
      if (hits.length) offenders.push(`${rel} (${hits.length})`);
    }
    expect(
      offenders,
      'These files touch the pending_new_book_sync marker directly. Use '
      + 'getPendingNewBook() / isPendingNewBook(bookId) / setPendingNewBook() / '
      + 'clearPendingNewBook(bookId) from resources/js/utilities/pendingNewBook.ts. '
      + 'If the question is actually "is a loading overlay appropriate", ask '
      + 'isLocalContentEntry() from SPA/navigation/localContentEntry instead — that is a '
      + 'presentation question, not a sync one.\nOffenders:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('the accessor still exists (no stale allowlist)', () => {
    const stale = [...ALLOWLIST].filter((rel) => !fs.existsSync(path.join(JS_ROOT, rel)));
    expect(stale, `Stale allowlist entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('the presentation callers ask localContentEntry, not the sync markers', () => {
    for (const rel of [
      'SPA/navigation/ProgressOverlayConductor.ts',
      'SPA/viewManager.ts',
      'SPA/navigation/pathways/FreshPageLoader.ts',
    ]) {
      const source = fs.readFileSync(path.join(JS_ROOT, rel), 'utf8');
      expect(source, `${rel} should import the presentation question`).toMatch(/localContentEntry/);
    }
  });
});
