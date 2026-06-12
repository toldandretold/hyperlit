<?php

namespace App\Services;

use App\Helpers\SubBookIdHelper;
use App\Models\PgLibrary;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Ensures sub-book library records exist for footnote/hyperlight sub-books.
 *
 * The nodes RLS insert policy requires an owned library row for nodes.book, so a
 * sub-book whose content exists client-side (e.g. seeded by paste import) but was
 * never registered on the backend can never sync its nodes — every unified sync
 * 500s on the RLS check, with no way to recover. Registering the library row here
 * (idempotently) breaks that chicken-and-egg.
 *
 * Ownership roots at the foundation book: rows are only created when the current
 * user owns the foundation's library record. RLS still applies (default
 * connection), so this can never create rows the policy would forbid.
 */
class SubBookRegistrar
{
    /**
     * Create missing library rows for the given sub-book ids. Idempotent and
     * best-effort: ids whose foundation isn't owned by the caller are skipped,
     * and per-row failures are isolated via savepoints so a caller's open
     * transaction survives. Returns the number of rows created.
     *
     * @param  string[]  $subBookIds  e.g. ["book_123/Fn456_abc", ...]
     */
    public static function ensureLibraryRecords(array $subBookIds, ?string $creator, ?string $creatorToken): int
    {
        $subBookIds = array_values(array_unique(array_filter(
            $subBookIds,
            fn ($id) => is_string($id) && str_contains($id, '/')
        )));

        if (empty($subBookIds) || ($creator === null && $creatorToken === null)) {
            return 0;
        }

        $existing = PgLibrary::whereIn('book', $subBookIds)->pluck('book')->all();
        $missing = array_diff($subBookIds, $existing);

        $created = 0;
        $foundations = [];

        foreach ($missing as $subBookId) {
            $parsed = SubBookIdHelper::parse($subBookId);
            $foundation = $parsed['foundation'];
            $itemId = $parsed['itemId'];

            if (! $itemId) {
                continue;
            }

            if (! array_key_exists($foundation, $foundations)) {
                $foundations[$foundation] = PgLibrary::where('book', $foundation)->first();
            }
            $foundationLib = $foundations[$foundation];

            if (! $foundationLib) {
                continue;
            }

            $isOwner = ($foundationLib->creator && $creator && $foundationLib->creator === $creator)
                || ($foundationLib->creator_token && $creatorToken && $foundationLib->creator_token === $creatorToken);

            if (! $isOwner) {
                Log::info('SubBookRegistrar: skipping sub-book (caller does not own foundation)', [
                    'sub_book_id' => $subBookId,
                ]);

                continue;
            }

            // Footnote sub-books inherit the foundation's visibility; annotation
            // (hyperlight) sub-books are public, mirroring SubBookController::create.
            $isFootnote = str_starts_with($itemId, 'Fn');

            try {
                // Nested transaction = savepoint: an RLS/unique failure here must not
                // abort a caller's open transaction (e.g. UnifiedSyncController's).
                DB::transaction(function () use ($subBookId, $itemId, $creator, $creatorToken, $isFootnote, $foundationLib) {
                    PgLibrary::firstOrCreate(
                        ['book' => $subBookId],
                        [
                            'creator' => $creator,
                            'creator_token' => $creatorToken,
                            'visibility' => $isFootnote ? ($foundationLib->visibility ?? 'private') : 'public',
                            'listed' => false,
                            'title' => 'Annotation: '.$itemId,
                            'type' => 'sub_book',
                            'has_nodes' => true,
                            'raw_json' => json_encode([]),
                            'timestamp' => 0,
                        ]
                    );
                });
                $created++;
            } catch (\Exception $e) {
                Log::warning('SubBookRegistrar: failed to create sub-book library record', [
                    'sub_book_id' => $subBookId,
                    'error' => $e->getMessage(),
                ]);
            }
        }

        if ($created > 0) {
            Log::info('SubBookRegistrar: created sub-book library records', ['count' => $created]);
        }

        return $created;
    }
}
