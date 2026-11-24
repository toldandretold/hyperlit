<?php

namespace App\Services\Marxists;

use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The marxists.org ARCHIVE on Hyperlit, and the authors its bulk import knows how to list
 * (docs/marxists-import.md).
 *
 * The archive is an ordinary maintainer archive: a system-owned public shelf + an
 * `archive_sources` row, so it has a hero page at /a/marxists-org and is reviewed lane by lane
 * in /maintainer/shelf-import like any other imported collection. Bulk-imported works are added
 * to it; the page credits the Marxists Internet Archive and every book links back to its own
 * contents page there.
 */
class MarxistsArchive
{
    public const SLUG = 'marxists-org';

    public const SHELF_NAME = 'marxists.org';

    public const DISPLAY_NAME = 'Marxists Internet Archive';

    /**
     * Authors the bulk import can list: the page on marxists.org that lists their works, and the
     * credit to assume for a page that names no author. `default_credit` is null for the
     * Marx/Engels archive on purpose — it holds two people's works under one folder, so a page
     * with no credit of its own is left unlinked rather than filed under Marx.
     *
     * `selected` is the author's Selected Works page, where marxists.org has one: the editors'
     * own choice of the works that matter. Works it links are flagged in the ledger so they can
     * be imported on their own (`marxists:import --selected`) instead of every letter and note.
     *
     * @var array<string, array{listing: string, default_credit: ?string, label: string, selected?: string}>
     */
    public const AUTHORS = [
        'marx' => [
            'label' => 'Karl Marx (and Engels — the Marx/Engels archive)',
            'listing' => 'https://www.marxists.org/archive/marx/works/date/index.htm',
            'selected' => 'https://www.marxists.org/archive/marx/works/sw/index.htm',
            'default_credit' => null,
        ],
        'lenin' => [
            'label' => 'V. I. Lenin',
            'listing' => 'https://www.marxists.org/archive/lenin/by-date.htm',
            'selected' => 'https://www.marxists.org/archive/lenin/works/sw/index.htm',
            'default_credit' => 'Vladimir Lenin',
        ],
        'trotsky' => [
            'label' => 'Leon Trotsky',
            'listing' => 'https://www.marxists.org/archive/trotsky/works/index.htm',
            'selected' => 'https://www.marxists.org/archive/trotsky/works/sw.htm',
            'default_credit' => 'Leon Trotsky',
        ],
        'luxemburg' => [
            'label' => 'Rosa Luxemburg',
            'listing' => 'https://www.marxists.org/archive/luxemburg/index.htm',
            'default_credit' => 'Rosa Luxemburg',
        ],
        'clr-james' => [
            'label' => 'C. L. R. James',
            'listing' => 'https://www.marxists.org/archive/james-clr/index.htm',
            'default_credit' => 'C.L.R. James',
        ],
    ];

    private static function db()
    {
        return DB::connection('pgsql_admin');
    }

    /** The archive's shelf, creating the shelf and its /a/ page on first use. */
    public static function ensureShelf(): string
    {
        $existing = self::db()->table('archive_sources')->where('slug', self::SLUG)->value('shelf_id');
        if ($existing) {
            return (string) $existing;
        }

        return self::db()->transaction(function () {
            $shelfId = self::db()->table('shelves')
                ->where('creator', AutoVersionResolver::CREATOR)->where('slug', self::SLUG)->value('id');

            if (! $shelfId) {
                $shelfId = (string) Str::uuid();
                self::db()->table('shelves')->insert([
                    'id' => $shelfId,
                    'creator' => AutoVersionResolver::CREATOR,
                    'creator_token' => null,
                    'name' => self::SHELF_NAME,
                    'slug' => self::SLUG,
                    'description' => 'Works imported from the Marxists Internet Archive (marxists.org).',
                    'visibility' => 'public',
                    'default_sort' => 'recent',
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }

            self::db()->table('archive_sources')->insert([
                'id' => (string) Str::uuid(),
                'shelf_id' => $shelfId,
                'slug' => self::SLUG,
                'display_name' => self::DISPLAY_NAME,
                'about' => 'Texts from the <a href="https://www.marxists.org/">Marxists Internet Archive</a>, '
                    . 'a volunteer-run library of Marxist writing. Each text here links back to its page on marxists.org '
                    . 'and carries the licence that page states.',
                'certified_at' => null,
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            return (string) $shelfId;
        });
    }
}
