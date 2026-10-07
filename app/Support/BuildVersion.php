<?php

namespace App\Support;

/**
 * One id per PUBLISHED front-end build.
 *
 * Its only job is to version the service worker's caches without a human
 * remembering to do it: `layout.blade.php` registers `/sw.js?v=<this>`, so a
 * new build means a new script URL, which means a new worker, which means
 * `public/sw.js`'s activate handler drops every cache from the previous build.
 *
 * The source of truth is the mtime of `public/build/manifest.json`, because
 * `scripts/publish-build.mjs` renames the manifest into place LAST, as the
 * final act of a build (docs/deploy.md). A deploy that rebuilds the front end
 * therefore always moves this value; a deploy that does not (PHP-only) leaves
 * it alone, which is correct — there is nothing stale to clear.
 */
final class BuildVersion
{
    private static ?string $memo = null;

    public static function current(): string
    {
        if (self::$memo !== null) {
            return self::$memo;
        }

        $manifest = public_path('build/manifest.json');
        $stamp = is_file($manifest) ? @filemtime($manifest) : false;

        // No manifest = dev (vite hot). A constant is right there: the dev SW
        // has no build to track, and a changing id would reinstall the worker
        // on every request.
        return self::$memo = $stamp ? 'b' . dechex($stamp) : 'dev';
    }

    /** Test seam — forget the memo so a fixture manifest can be re-read. */
    public static function forget(): void
    {
        self::$memo = null;
        clearstatcache();
    }
}
