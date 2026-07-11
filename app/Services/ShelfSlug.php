<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Unique shelf-slug generation, scoped per creator (shelves carry a
 * UNIQUE (creator, slug) index). Extracted from ShelfController so the
 * Source Network Harvester's server-side shelf creation (HarvestShelf) and
 * the HTTP create/update path share one algorithm and can't drift.
 *
 * Reads via pgsql_admin: the check must see ALL of the creator's shelves
 * regardless of the caller's RLS context (queue workers have none).
 */
class ShelfSlug
{
    /**
     * Appends -2, -3 etc. until the slug is free within the creator's scope.
     */
    public static function unique(string $name, string $creator, ?string $excludeId = null): string
    {
        $baseSlug = Str::slug($name);
        if ($baseSlug === '') {
            $baseSlug = 'shelf';
        }

        $slug = $baseSlug;
        $counter = 2;

        while (true) {
            $query = DB::connection('pgsql_admin')->table('shelves')
                ->where('creator', $creator)
                ->where('slug', $slug);

            if ($excludeId) {
                $query->where('id', '!=', $excludeId);
            }

            if (!$query->exists()) {
                break;
            }

            $slug = $baseSlug . '-' . $counter;
            $counter++;
        }

        return $slug;
    }
}
