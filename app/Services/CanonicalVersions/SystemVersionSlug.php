<?php

namespace App\Services\CanonicalVersions;

use App\Support\SlugRules;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Gives a system-owned version a readable URL once it has something to read.
 *
 * SystemVersionMinter ids are raw UUIDs, so the copy a verified citation links to lived at
 * /b75d82b6-… . A slug is a PERMANENT public address, hence the conditions: only a
 * system-minted row (a user chooses their own slug), only public (a licence-held copy has no
 * public URL to name), and only once content has landed — a stub that never fills must not
 * squat a title another edition could use. Idempotent; never replaces an existing slug.
 */
class SystemVersionSlug
{
    /** The slug now on the row (existing or just minted), or null when the row doesn't qualify. */
    public static function ensure(string $bookId): ?string
    {
        try {
            $db = DB::connection('pgsql_admin');
            $row = $db->table('library')->where('book', $bookId)
                ->first(['slug', 'title', 'author', 'year', 'creator', 'visibility', 'has_nodes']);

            if (! $row) {
                return null;
            }
            if ($row->slug) {
                return $row->slug;
            }
            if ($row->creator !== AutoVersionResolver::CREATOR
                || $row->visibility !== 'public'
                || ! $row->has_nodes
                || str_contains($bookId, '/')
                || trim((string) $row->title) === '') {
                return null;
            }

            $candidate = SlugRules::candidateFrom(
                (string) $row->title,
                $row->author,
                $row->year ? (int) $row->year : null,
            );
            $slug = $candidate ? SlugRules::uniqueFrom($candidate, $bookId) : null;
            if ($slug === null) {
                return null;
            }

            // whereNull guard: two workers finishing the same book must not overwrite each other.
            $db->table('library')->where('book', $bookId)->whereNull('slug')->update(['slug' => $slug]);

            return $db->table('library')->where('book', $bookId)->value('slug');
        } catch (\Throwable $e) {
            // A lost race on the unique index, or anything else: the book keeps its id URL.
            // Never fail an import over a vanity address.
            Log::warning('SystemVersionSlug: could not mint slug', ['book' => $bookId, 'error' => $e->getMessage()]);

            return null;
        }
    }
}
