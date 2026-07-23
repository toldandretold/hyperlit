/**
 * Age-prune public/build/assets before a vite build.
 *
 * vite.config.js sets build.emptyOutDir: false so a deploy does NOT delete the
 * hashed chunks that live clients (open tabs, service-worker caches) are still
 * dynamic-importing — that deletion is what wedged prod with "Importing a
 * module script failed". Old hashes are content-addressed and immutable, so
 * keeping them around is free correctness; this script stops them accumulating
 * forever by deleting assets untouched for MAX_AGE_DAYS. Anything a current
 * build still emits gets rewritten (fresh mtime) every build, so live files
 * never age out — only genuinely dead hashes do.
 *
 * Run automatically by `npm run build`; safe when the directory doesn't exist.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_AGE_DAYS = 7;

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'build', 'assets');
const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

let pruned = 0;
let kept = 0;
try {
  for (const name of readdirSync(assetsDir)) {
    const path = join(assetsDir, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      if (stats.mtimeMs < cutoff) {
        unlinkSync(path);
        pruned++;
      } else {
        kept++;
      }
    } catch { /* raced/unreadable entry — leave it */ }
  }
  console.log(`[prune-old-build-assets] kept ${kept}, pruned ${pruned} (older than ${MAX_AGE_DAYS}d)`);
} catch {
  console.log('[prune-old-build-assets] no public/build/assets yet — nothing to prune');
}
