/**
 * The service worker's cache version is DERIVED FROM THE BUILD, not hand-bumped.
 *
 * `public/sw.js` caches `/build/` assets CacheFirst and never revalidates them,
 * so a client that cached a bad asset (a truncated 200 mid-publish, a CDN-cached
 * 404) stays wedged — "Loading… / Initializing…" forever — until the cache NAME
 * changes. For a year that name came from a constant someone had to remember to
 * bump. It was last bumped 2026-09-09 and then missed on 41 consecutive
 * front-end commits, with the deploy script dutifully warning into a log nobody
 * reads. A discipline is not a mechanism.
 *
 * The mechanism: layout.blade.php registers `/sw.js?v=<App\Support\BuildVersion>`
 * (the published manifest's mtime), so a new build is a new script URL, which
 * installs a new worker, which deletes every other `hyperlit-*` cache on
 * activate. This test pins each link of that chain.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const sw = readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8');
const layout = readFileSync(join(ROOT, 'resources', 'views', 'layout.blade.php'), 'utf8');
const buildVersion = readFileSync(join(ROOT, 'app', 'Support', 'BuildVersion.php'), 'utf8');

describe('service worker cache version is derived, not hand-maintained', () => {
  it('sw.js reads its version from its own script URL', () => {
    expect(sw).toMatch(/searchParams\.get\(\s*['"]v['"]\s*\)/);
    // A bare literal assignment is the shape that rotted — the version must be
    // computed from RAW_VERSION, never pinned to a string.
    expect(sw).not.toMatch(/^const CACHE_VERSION = ['"]v\d+['"]/m);
  });

  it('sanitises the version before interpolating it into cache names', () => {
    expect(sw).toMatch(/RAW_VERSION\.replace\(/);
    expect(sw).toMatch(/hyperlit-static-\$\{CACHE_VERSION\}/);
    expect(sw).toMatch(/hyperlit-dynamic-\$\{CACHE_VERSION\}/);
  });

  it('activate still deletes every hyperlit-* cache that is not this version', () => {
    // The whole scheme depends on this sweep: a new version name is only a
    // cache BUST because the previous names get deleted here.
    expect(sw).toMatch(/name\.startsWith\(\s*['"]hyperlit-['"]\s*\)/);
    expect(sw).toMatch(/name !== STATIC_CACHE && name !== DYNAMIC_CACHE/);
  });

  it('the layout registers the worker WITH the build id, at scope /', () => {
    const register = layout.match(/navigator\.serviceWorker\.register\([^\n]*/)?.[0] ?? '';
    expect(register).toContain('/sw.js?v=');
    expect(register).toContain('BuildVersion::current()');
    // Same scope = this REPLACES the existing worker rather than adding one.
    expect(register).toMatch(/scope:\s*['"]\/['"]/);
    expect(register).toMatch(/updateViaCache:\s*['"]none['"]/);
  });

  it('the build id tracks the published manifest, which is renamed in LAST', () => {
    expect(buildVersion).toContain("public_path('build/manifest.json')");
    expect(buildVersion).toMatch(/filemtime/);
  });
});
