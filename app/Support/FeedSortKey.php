<?php

namespace App\Support;

/**
 * The ONE collation key for title/author feed sorting (library-catalog
 * convention): LEADING punctuation, symbols and whitespace are ignored, so
 * "'Real Socialism' in Historical Perspective" files under R and
 * "[selected] Records of the General Conference" under S — instead of the
 * raw codepoint order that put quote-led titles above the digits and
 * bracket-led ones between digits and letters. Interior punctuation still
 * counts, and digits keep sorting before letters (2026 Census… before Apple).
 *
 * Used by UserHomeServerController::renderSortedFeed and
 * ShelfController::renderShelfFeed — both arms of each, so the Library and
 * shelf views always agree. NOTE the rendered title/author variants are
 * cached indefinitely (only connected/lit self-expire), so a change to this
 * key needs the cached variants flushed (any card mutation does it, or
 * `php artisan users:regenerate-home-pages` for a full sweep).
 */
final class FeedSortKey
{
    public static function for(?string $value): string
    {
        $value = (string) $value;
        $stripped = preg_replace('/^[^\p{L}\p{N}]+/u', '', $value) ?? '';

        // A value that is ONLY punctuation would strip to '' and interleave
        // arbitrarily with missing values — keep its own (lowercased) form so
        // it still sorts deterministically.
        return mb_strtolower($stripped !== '' ? $stripped : $value);
    }
}
