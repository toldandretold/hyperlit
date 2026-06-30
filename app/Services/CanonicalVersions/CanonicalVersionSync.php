<?php

namespace App\Services\CanonicalVersions;

use App\Models\CanonicalSource;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * The single PUBLIC entrypoint for re-evaluating a canonical's privileged-version
 * pointers (auto_/author_/publisher_/commons_version_book). Everything that
 * changes a book's eligibility — content landing (import/reconvert), and deletion —
 * routes through here so the resolver registry is consulted in exactly one place.
 *
 * Previously this logic lived private inside ContentFetchService; it now delegates
 * to this service so the document-import job and book deletion share it.
 */
class CanonicalVersionSync
{
    /**
     * A book's content/eligibility changed → let every version authority
     * re-evaluate its pointer for that book's canonical. Best-effort: never
     * throws (a canonical-layer hiccup must not fail the import/reconvert).
     *
     * Returns the pointers that hold a value after the sweep, e.g.
     * ['auto_version_book' => '…'] — or [] if the book isn't canonical-linked.
     */
    public function syncForBook(string $bookId, bool $force = false): array
    {
        try {
            $canonicalId = DB::connection('pgsql_admin')
                ->table('library')
                ->where('book', $bookId)
                ->value('canonical_source_id');

            if (!$canonicalId) {
                return [];
            }

            $canonical = CanonicalSource::find($canonicalId);
            if (!$canonical) {
                return [];
            }

            $assigned = VersionPointerRegistry::syncAll($canonical, $force);
            if (!empty($assigned)) {
                Log::info('Canonical version pointers synced', [
                    'book'      => $bookId,
                    'canonical' => $canonicalId,
                    'assigned'  => $assigned,
                ]);
            }

            return $assigned;
        } catch (\Throwable $e) {
            Log::warning('Canonical pointer sync failed (caller unaffected)', [
                'book'  => $bookId,
                'error' => $e->getMessage(),
            ]);

            return [];
        }
    }

    /**
     * A book (and optionally its descendants) is being deleted → NULL any canonical
     * pointer that names one of them, then re-resolve so the pointer refills from
     * any remaining eligible (non-deleted) system version, or stays NULL.
     *
     * Needed because BasePointerResolver::assign() is fill-only: resolve() already
     * excludes visibility='deleted', but a stale non-empty pointer is never
     * reconsidered until it's cleared. Closes the dangling-pointer footgun.
     */
    public function clearAndResyncForDeletedBook(string $bookId, array $descendantIds = []): void
    {
        try {
            $books = array_values(array_unique(array_merge([$bookId], $descendantIds)));
            $columns = VersionPointerRegistry::precedenceColumns();

            // Find canonicals whose pointer references any of the deleted books.
            $orphaned = CanonicalSource::query()
                ->where(function ($q) use ($columns, $books) {
                    foreach ($columns as $col) {
                        $q->orWhereIn($col, $books);
                    }
                })
                ->get();

            foreach ($orphaned as $canonical) {
                foreach ($columns as $col) {
                    if (in_array($canonical->{$col}, $books, true)) {
                        $canonical->{$col} = null;
                    }
                }
                $canonical->save();

                // Refill from any remaining eligible version (or leave NULL).
                VersionPointerRegistry::syncAll($canonical);
            }
        } catch (\Throwable $e) {
            Log::warning('Canonical pointer clear-on-delete failed (deletion unaffected)', [
                'book'  => $bookId,
                'error' => $e->getMessage(),
            ]);
        }
    }
}
