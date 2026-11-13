<?php

namespace App\Services\Shelves;

use App\Models\ArchiveSource;
use App\Support\UsernameKey;

/**
 * Where "open this shelf" goes: its archive page (/a/{slug}) when it has one
 * and the shelf is public — that page IS the shelf's home page — otherwise the
 * shelf on its creator's user page. (A private shelf's archive page shows
 * nothing, so it is never the destination.)
 */
class ShelfHomeUrl
{
    /** @param  object  $shelf  needs id, slug, creator, visibility */
    public static function for(object $shelf, ?string $archiveSlug = null): string
    {
        if (($shelf->visibility ?? null) === 'public') {
            $archiveSlug ??= ArchiveSource::where('shelf_id', $shelf->id)->value('slug');
            if ($archiveSlug) {
                return url('/a/' . $archiveSlug);
            }
        }

        return UsernameKey::shelfUrl((string) $shelf->creator, $shelf->slug ?: $shelf->id);
    }
}
