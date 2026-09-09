/**
 * Atomically publish a staged vite build into public/build.
 *
 * WHY THIS EXISTS — the deploy builds in place on the LIVE docroot, so for the
 * duration of `vite build` the directory the site is serving is half-written.
 * Two things go wrong there, and both surface as Safari's "Importing a module
 * script failed" / Chrome's "Failed to fetch dynamically imported module":
 *
 *  1. manifest.json is written BEFORE the last chunks. Measured on prod
 *     (2026-09-09 deploy): manifest at 09:18:00.507, but utils/viewportMetrics
 *     at .511 and scene-*.js (570 KB) at .535 — a window in which the HTML
 *     advertises hashed chunks that are NOT ON DISK YET. A page load landing
 *     there 404s on a module and is dead until reloaded.
 *  2. Worse: a chunk being WRITTEN can be served truncated (200 + short body).
 *     The service worker caches any `ok` response for /build/, so a truncated
 *     module gets cached and that client stays broken across reloads — which
 *     is why the symptom "comes back every deploy" and why bumping
 *     CACHE_VERSION in public/sw.js appears to fix it (it nukes the poisoned
 *     cache) without ever fixing the cause.
 *
 * THE FIX — nobody learns a new chunk's hash until the manifest names it, so
 * publishing is safe as long as the manifest goes last:
 *   - vite builds into public/build-next (staging, emptied each run),
 *   - assets are renamed into public/build/assets one by one (same filesystem
 *     ⇒ atomic per file; hashed names are content-addressed so an existing
 *     name is byte-identical and is simply kept),
 *   - manifest.json is renamed into place LAST, atomically.
 * Old chunks are never deleted here — live tabs keep resolving them, and
 * scripts/prune-old-build-assets.mjs age-prunes afterwards.
 *
 * Retention invariant: prune deletes assets untouched for 7 days, relying on
 * "a live asset is rewritten by every build". Staging breaks that (an unchanged
 * chunk is not re-written, it is kept), so every asset the new manifest depends
 * on gets its mtime refreshed here. Without that, chunks whose content hasn't
 * changed in a week would age out from under live clients.
 */
import {
  existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = join(ROOT, 'public', 'build-next');
const LIVE = join(ROOT, 'public', 'build');

if (!existsSync(STAGING)) {
  console.error(`[publish-build] no staged build at ${STAGING} — run \`vite build --outDir public/build-next --emptyOutDir\` first`);
  process.exit(1);
}

const stagedManifest = join(STAGING, 'manifest.json');
// Vite ≥5 can emit the manifest under .vite/ — handle both layouts.
const stagedManifestAlt = join(STAGING, '.vite', 'manifest.json');
const manifestSrc = existsSync(stagedManifest) ? stagedManifest
  : existsSync(stagedManifestAlt) ? stagedManifestAlt : null;
if (!manifestSrc) {
  console.error('[publish-build] staged build has no manifest.json — refusing to publish a partial build');
  process.exit(1);
}

mkdirSync(join(LIVE, 'assets'), { recursive: true });

const now = new Date();
let moved = 0;
let kept = 0;

/** Move every file under `rel` (recursively) from staging to live. */
function publishDir(rel) {
  const srcDir = join(STAGING, rel);
  if (!existsSync(srcDir)) return;
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dst = join(LIVE, rel, name);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      publishDir(join(rel, name));
      continue;
    }
    if (existsSync(dst)) {
      // Same hashed name ⇒ same bytes. Keep the live copy (an open tab may be
      // mid-fetch on it) and just refresh its mtime so prune won't age it out.
      utimesSync(dst, now, now);
      kept++;
    } else {
      renameSync(src, dst);
      moved++;
    }
  }
}

publishDir('assets');

// Any other top-level artifacts (e.g. chunkmap.json from BUNDLE_GATE=1), but
// NEVER the manifest — that one is the publish barrier and goes last.
for (const name of readdirSync(STAGING)) {
  if (name === 'assets' || name === 'manifest.json' || name === '.vite') continue;
  const src = join(STAGING, name);
  if (statSync(src).isDirectory()) continue;
  renameSync(src, join(LIVE, name));
}

// THE BARRIER: an atomic same-filesystem rename. Until this line, no client can
// learn the new hashes; after it, every file it names is already fully on disk.
const manifestDst = join(LIVE, 'manifest.json');
renameSync(manifestSrc, manifestDst);
// rename() preserves the staged mtime; stamp it with the publish time so
// "when did this deploy land" reads honestly off the filesystem — and so the
// invariant stays checkable on the server with:
//   find assets -type f -newer manifest.json      # must print NOTHING
// (the `assets` DIRECTORY will be newer — its mtime bumps as files move in.)
utimesSync(manifestDst, new Date(), new Date());

rmSync(STAGING, { recursive: true, force: true });

console.log(`[publish-build] published ${moved} new asset(s), kept ${kept} unchanged, manifest swapped atomically`);
