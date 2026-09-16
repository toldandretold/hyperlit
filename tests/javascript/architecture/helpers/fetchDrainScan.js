/**
 * Shared scanner for "fetch() whose Response body is never consumed".
 *
 * An unconsumed Response body keeps the request in-flight: the browser holds
 * the connection open (HTTP/1.1 caps at 6 per origin) and Playwright never
 * fires `requestfinished`, so a page with one undrained response can NEVER
 * reach network-idle. That bug has shipped twice — `utilities/auth/session.ts`
 * (429, 2026-09-08) and `scrolling/pageViewTelemetry.ts` (401, 2026-09-16,
 * which hung ~30 e2e specs on `goto('/')`).
 *
 * Lives in a helper (not inline in the test) because the same scan is used by
 * the guardrail and by the one-off audit script that produced the baseline.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/** Methods that consume (drain) a Response body. `.body` = manual stream use. */
const CONSUMERS = ['.json(', '.text(', '.blob(', '.arrayBuffer(', '.formData(', '.body'];

/** The shared helper in resources/js/utilities/drainResponse.ts. */
const DRAIN_HELPER = 'drainResponse';

/**
 * Blank out comments and string/template contents, preserving length and
 * newlines so offsets and line numbers stay valid. Without this, the word
 * "fetch()" inside a prose comment reads as a call site.
 */
export function maskCode(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** From the index of '(' return the index just past its matching ')'. */
function matchParen(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Extend past chained .then()/.catch()/.finally(), skipping whitespace. */
function extendChain(masked, end) {
  let i = end;
  for (;;) {
    let j = i;
    while (j < masked.length && /\s/.test(masked[j])) j++;
    const m = /^\.(then|catch|finally)\s*\(/.exec(masked.slice(j, j + 40));
    if (!m) return i;
    const open = masked.indexOf('(', j);
    const close = matchParen(masked, open);
    if (close === -1) return i;
    i = close;
  }
}

export function collectSourceFiles(root, out = []) {
  for (const entry of readdirSync(root)) {
    if (entry === 'archive' || entry === 'node_modules') continue;
    const p = join(root, entry);
    if (statSync(p).isDirectory()) collectSourceFiles(p, out);
    else if (/\.(ts|js)$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * @returns {Array<{file: string, line: number, reason: string}>} undrained sites
 */
export function findUndrainedFetches(root, repoRoot) {
  const findings = [];

  for (const file of collectSourceFiles(root)) {
    const src = readFileSync(file, 'utf8');
    const masked = maskCode(src);
    const rel = relative(repoRoot, file).split(/[\\/]/).join('/');

    const re = /\bfetch\s*\(/g;
    let m;
    while ((m = re.exec(masked))) {
      const prev = masked[m.index - 1];
      if (prev && /[A-Za-z0-9_$]/.test(prev)) continue; // prefetch(, etc.

      const open = masked.indexOf('(', m.index);
      const close = matchParen(masked, open);
      if (close === -1) continue;
      const chainEnd = extendChain(masked, close);
      const expr = masked.slice(m.index, chainEnd);
      const line = src.slice(0, m.index).split('\n').length;

      // Consumed inline: `.then(r => r.json())`, `(await fetch()).text()`,
      // or `.then(drainResponse)`.
      if (CONSUMERS.some((c) => expr.includes(c))) continue;
      if (expr.includes(DRAIN_HELPER)) continue;

      const head = masked.slice(Math.max(0, m.index - 160), m.index);

      // Wrapped in place: `const res = await drainResponse(await fetch(...))`.
      if (new RegExp(`${DRAIN_HELPER}\\s*\\(\\s*(?:await\\s+)?$`).test(head)) continue;

      // `return fetch(...)` / `return await fetch(...)` — the caller owns it.
      if (/\breturn\s+(?:await\s+)?$/.test(head)) continue;

      // Inside an array literal (Promise.all([...])) — consumed via the
      // destructured results, which this line-local scan cannot see.
      if (/\[[^\]]*$/.test(head)) continue;

      // Assigned: consider it drained if the variable is later read. The
      // optional `: Type` arm matters — `const resp: any = await fetch(...)`
      // otherwise captures "any" as the variable name and every such site
      // reads as undrained even when it calls resp.json() on the next line.
      const assign = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=;{}\n]+?)?\s*=\s*(?:await\s+)?$/.exec(head)
        || /([A-Za-z0-9_$]+)\s*(?::\s*[^=;{}\n]+?)?\s*=\s*(?:await\s+)?$/.exec(head);
      if (assign) {
        const v = assign[1];
        const after = masked.slice(chainEnd, chainEnd + 4000);
        if (CONSUMERS.some((c) => after.includes(v + c))) continue;
        findings.push({ file: rel, line, reason: `response \`${v}\` is never read` });
        continue;
      }

      findings.push({ file: rel, line, reason: 'response discarded' });
    }
  }

  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return findings;
}
