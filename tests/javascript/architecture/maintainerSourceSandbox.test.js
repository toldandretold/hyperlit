/**
 * GUARDRAIL: the maintainer source panes must sandbox the fetched publisher page.
 *
 * /maintainer/conversion and /maintainer/journal-import show a page we scraped off the open web,
 * served from OUR origin by the `original` endpoint. Without a sandbox the publisher's JavaScript
 * executes same-origin with the admin console: the session cookie is HttpOnly, but same-origin
 * `fetch('/api/…')` doesn't need to read it — the browser attaches it. A hostile or compromised
 * page could therefore drive the maintainer API (retract, promote, resolve) as the logged-in admin.
 *
 * The required value is exactly `allow-same-origin`, and the pair matters:
 *   - WITHOUT `allow-scripts` → nothing executes. That's the fix.
 *   - WITH `allow-same-origin` → the document keeps our origin, so utilities/sourceFrameTheme.ts
 *     can still inject the reading theme. A bare `sandbox=""` would give it an opaque origin and
 *     silently break the theming (and leave the pane black-on-dark).
 * Adding `allow-scripts` alongside `allow-same-origin` would undo the whole thing — that pair lets
 * a frame remove its own sandbox — so this test fails on it explicitly.
 *
 * Runs in `npm test` (no server).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const PANES = [
  'resources/js/maintainer/main.ts',
  'resources/js/maintainerJournalImport/main.ts',
];

describe('maintainer source panes sandbox the fetched page', () => {
  it.each(PANES)('%s sandboxes with allow-same-origin', (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');

    expect(
      src.includes("setAttribute('sandbox', 'allow-same-origin')"),
      `${file} must set sandbox="allow-same-origin" on its source iframe before loading a fetched `
      + `page — otherwise scraped publisher JS runs same-origin with the admin console.`,
    ).toBe(true);
  });

  it.each(PANES)('%s never grants allow-scripts to the source frame', (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const grantsScripts = /sandbox['"],\s*['"][^'"]*allow-scripts/.test(src);

    expect(
      grantsScripts,
      `${file} grants allow-scripts to the source frame. Combined with allow-same-origin that lets `
      + `the framed page remove its own sandbox, which is the whole thing we are preventing.`,
    ).toBe(false);
  });
});
