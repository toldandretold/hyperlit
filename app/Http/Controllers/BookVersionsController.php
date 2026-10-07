<?php

namespace App\Http\Controllers;

use App\Models\PgLibrary;
use Illuminate\Http\JsonResponse;

/**
 * "Versions / Translations" — the source container's rail of OTHER editions
 * of the work the reader is looking at: its translation family (via the
 * translated_from lineage columns) and other library versions of the same
 * canonical_source. This fills the gap docs/canonical-sources.md names
 * ("the UI can show 'Other versions of this work'").
 *
 * Deliberately its OWN controller: pure public reads, none of
 * BookTranslationController's billing/lock/progress machinery.
 *
 * Every query runs on the DEFAULT (RLS) connection — "what may this caller
 * see" is exactly RLS's question (BestVersionService's documented rule), so
 * a private translation appears only to its owner and everyone else's list
 * simply omits it. We never need to distinguish private from absent here.
 */
class BookVersionsController extends Controller
{
    /** Canonical siblings shown at most — a heavily-versioned work is a feed, not a rail. */
    private const MAX_CANONICAL_SIBLINGS = 12;

    /**
     * "Original edited since this translation" compares the original's
     * `timestamp` (client ms epoch, bumped by every edit session) against the
     * copy's `created_at` (server seconds). The grace absorbs the unit
     * truncation plus client clock skew — a note, not a verdict, so a false
     * negative beats a false positive.
     */
    private const EDITED_SINCE_GRACE_SECONDS = 300;

    public function index(string $book): JsonResponse
    {
        // Versions belong to the ROOT book; sub-books aren't library rows.
        if (str_contains($book, '/')) {
            return response()->json(['success' => false, 'message' => 'Book not found.'], 404);
        }
        /** @var PgLibrary|null $current */
        $current = PgLibrary::where('book', $book)->first();
        if (! $current) {
            // RLS visibility: an invisible book reads as nonexistent.
            return response()->json(['success' => false, 'message' => 'Book not found.'], 404);
        }

        // The translation family, ONE hop of lineage: the root (the viewed
        // book, or its immediate source when the viewed book IS a
        // translation) plus every visible translation of that root.
        $rootId = $current->translated_from ?: $current->book;
        $family = PgLibrary::where(fn ($q) => $q->where('book', $rootId)->orWhere('translated_from', $rootId))
            ->orderBy('created_at')
            ->get();
        $root = $family->firstWhere('book', $rootId);

        // Other versions of the same canonical work (the uncalled
        // CanonicalSource::versions() set), excluding the family itself.
        $siblings = collect();
        if ($current->canonical_source_id) {
            $siblings = PgLibrary::where('canonical_source_id', $current->canonical_source_id)
                ->whereNotIn('book', $family->pluck('book'))
                ->where('has_nodes', true)
                ->orderByDesc('total_views')
                ->limit(self::MAX_CANONICAL_SIBLINGS)
                ->get();
        }

        $versions = $family
            ->map(fn (PgLibrary $row) => $this->entry($row, $root, $row->translated_from !== null ? 'translation' : 'original', $current->book))
            ->concat($siblings->map(fn (PgLibrary $row) => $this->entry($row, $root, 'canonical_version', $current->book)))
            ->values();

        return response()->json(['success' => true, 'book' => $current->book, 'versions' => $versions]);
    }

    /** @return array<string, mixed> */
    private function entry(PgLibrary $row, ?PgLibrary $root, string $kind, string $currentBook): array
    {
        $raw = is_array($row->raw_json) ? $row->raw_json : [];

        return [
            'book' => $row->book,
            'title' => $row->title,
            'language' => $row->language,
            'creator' => $row->creator,
            'created_at' => $row->created_at?->toIso8601String(),
            'kind' => $kind,
            'is_current' => $row->book === $currentBook,
            'translation' => $kind !== 'translation' ? null : [
                'target' => $row->translation_target,
                'model' => $raw['translation_model'] ?? null,
                // human_reviewed_at = "a logged-in user saved the editor on
                // this copy" — the co-translator signal. Unset at mint.
                'human_reviewed' => $row->human_reviewed_at !== null,
                'original_edited_since' => $root !== null
                    && $root->timestamp
                    && $row->created_at
                    && (int) $root->timestamp > ($row->created_at->getTimestamp() + self::EDITED_SINCE_GRACE_SECONDS) * 1000,
            ],
        ];
    }
}
