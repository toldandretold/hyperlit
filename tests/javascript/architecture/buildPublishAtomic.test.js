/**
 * The production build must be published ATOMICALLY (docs/deploy.md).
 *
 * The deploy runs `npm run build` in place on the live docroot. Writing vite's
 * output straight into `public/build` leaves the served directory half-written
 * for the length of the build: the manifest lands before the last chunks (so
 * the HTML advertises files that aren't on disk yet), and a chunk still being
 * written can be served TRUNCATED as a 200 — which the service worker caches,
 * breaking that client until someone bumps CACHE_VERSION. That is the
 * "Importing a module script failed" that came back on every deploy.
 *
 * The shape that prevents it: build into a staging dir, move the assets, then
 * rename `manifest.json` into place LAST. This test pins that shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const publisher = readFileSync(join(ROOT, 'scripts', 'publish-build.mjs'), 'utf8');

describe('production build publishes atomically', () => {
  const build = pkg.scripts.build;

  it('builds into the staging dir, never straight into public/build', () => {
    expect(build).toContain('--outDir public/build-next');
    expect(build).toContain('--emptyOutDir');
    // A bare `vite build` (no outDir) writes into public/build — the bug.
    expect(build).not.toMatch(/vite build(?!\s+--outDir)/);
  });

  it('runs the publish step, and prunes only AFTER publishing', () => {
    expect(build).toContain('scripts/publish-build.mjs');
    const publishAt = build.indexOf('publish-build.mjs');
    const pruneAt = build.indexOf('prune-old-build-assets.mjs');
    expect(publishAt).toBeGreaterThan(-1);
    // Pruning before the publish could delete an asset the new manifest needs
    // (its mtime is only refreshed by the publish).
    expect(pruneAt).toBeGreaterThan(publishAt);
  });

  it('renames the manifest LAST — after every asset is in place', () => {
    const assetsAt = publisher.indexOf("publishDir('assets')");
    const manifestRenameAt = publisher.search(/renameSync\(\s*manifestSrc/);
    expect(assetsAt).toBeGreaterThan(-1);
    expect(manifestRenameAt).toBeGreaterThan(assetsAt);
  });

  it('refreshes the mtime of kept assets so the 7-day prune cannot age out live chunks', () => {
    expect(publisher).toMatch(/utimesSync\(dst/);
  });

  it('never deletes from the live build dir (old chunks serve open tabs)', () => {
    // Only the staging dir may be removed.
    const removals = publisher.match(/rmSync\(([^,)]+)/g) || [];
    expect(removals.length).toBeGreaterThan(0);
    for (const call of removals) expect(call).toContain('STAGING');
    expect(publisher).not.toMatch(/unlinkSync|rmSync\(\s*LIVE/);
  });
});
