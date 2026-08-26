<?php

namespace App\Services\JournalHarvest;

use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Conversion\ReconvertQueue;
use App\Services\ShelfCacheInvalidator;
use Illuminate\Support\Facades\DB;

/**
 * "Make this lane the version."
 *
 * When a work carries more than one system lane (PDF + publisher HTML), something has to decide
 * which one readers get. Today nothing does, deliberately-ish: `AutoVersionResolver` picks the
 * EARLIEST-CREATED eligible row, so the winner is whichever lane happened to be minted first —
 * arbitrary, and invisible. `BasePointerResolver::assign()` is fill-only, so once the pointer is
 * set on purpose no sweep will move it; this class is the missing "on purpose".
 *
 * Promotion is three facts kept in step:
 *   1. `canonical_source.auto_version_book` names the winner — that pointer is what /j/{slug},
 *      the shelves and readers resolve through (BestVersionService::sqlCoalesceExpression).
 *   2. The winner is `listed` (public), via the existing ReconvertQueue::promoteApprovedHarvest
 *      so the same guards apply as on the conversion page's approve button.
 *   3. Every sibling lane is UNLISTED — imported, still there to compare against, invisible to
 *      readers. Losing a comparison is not grounds for deletion; HarvestRetraction is.
 */
class JournalVersionPromoter
{
    public function __construct(private ReconvertQueue $queue)
    {
    }

    /**
     * Conversion method stamped on a lane an OPERATOR published despite it failing the automatic
     * authenticity gate. A distinct value on purpose: "a person looked at this and vouched for it"
     * is a different provenance claim from "the gate confirmed it", and collapsing the two would
     * make `paste_engine_html` mean two things. It IS in SYSTEM_CONVERSION_METHODS, so the
     * decision survives the next pointer re-resolution instead of being silently undone.
     */
    public const OPERATOR_APPROVED_METHOD = 'paste_engine_html_operator_approved';

    /**
     * @param  bool  $force  publish a lane the authenticity gate did not confirm. The operator has
     *                       read it; the structural refusals below still apply, because those
     *                       describe a lane that cannot be resolved at all rather than one we are
     *                       merely unsure about.
     * @return array{promoted: bool, reason: ?string, canonical_id: ?string, demoted: array<int, string>}
     */
    public function promote(string $book, bool $force = false): array
    {
        $db = DB::connection('pgsql_admin');

        $row = $db->table('library')
            ->where('book', $book)
            ->select('book', 'canonical_source_id', 'has_nodes', 'visibility', 'conversion_method', 'creator')
            ->first();

        if (! $row || $row->visibility === 'deleted') {
            return $this->refuse('not_found');
        }
        if (! $row->canonical_source_id) {
            return $this->refuse('not_linked_to_a_canonical');
        }
        if (! $row->has_nodes) {
            // An empty lane would make the work unreadable everywhere it's resolved.
            return $this->refuse('no_content');
        }
        if (! in_array($row->conversion_method, AutoVersionResolver::SYSTEM_CONVERSION_METHODS, true)) {
            // html_scrape_unverified lands here by design: the authenticity gate did not confirm
            // the page IS the article, so it must never become the canonical version AUTOMATICALLY.
            // An operator who has read the lane can overrule that — the gate's job is to refuse
            // when unsure, not to outrank a human who has checked.
            if (! $force) {
                return $this->refuse('not_a_system_version:' . ($row->conversion_method ?? 'none'));
            }

            $db->table('library')->where('book', $book)->update([
                'conversion_method' => self::OPERATOR_APPROVED_METHOD,
                'updated_at'        => now(),
            ]);
        }

        $db->table('canonical_source')
            ->where('id', $row->canonical_source_id)
            ->update(['auto_version_book' => $book, 'updated_at' => now()]);

        $this->queue->promoteApprovedHarvest($book);

        // Unlist the siblings so exactly one lane is public.
        $demoted = [];
        $siblings = $db->table('library')
            ->where('canonical_source_id', $row->canonical_source_id)
            ->where('book', '!=', $book)
            ->where('visibility', '!=', 'deleted')
            ->where('listed', true)
            ->pluck('book');

        foreach ($siblings as $sibling) {
            $db->table('library')->where('book', $sibling)
                ->update(['listed' => false, 'updated_at' => now()]);
            $demoted[] = $sibling;
        }

        $this->reshelve($row->canonical_source_id, $book);

        return [
            'promoted'     => true,
            'reason'       => null,
            'canonical_id' => $row->canonical_source_id,
            'demoted'      => $demoted,
        ];
    }

    /**
     * Swap the winner onto the journal's shelf in place of its siblings.
     *
     * HarvestShelf::syncJournalShelfMembership is additive — it adds books that belong and never
     * removes any — so after a promotion the shelf still lists the lane we just demoted, and the
     * journal's feeds would serve the version nobody chose. Promotion is the only moment a
     * work's membership can become wrong, so it is the right place to reconcile it.
     */
    private function reshelve(string $canonicalId, string $winner): void
    {
        $shelfId = DB::connection('pgsql_admin')->table('canonical_source as cs')
            ->join('journal_sources as js', 'js.id', '=', 'cs.journal_source_id')
            ->where('cs.id', $canonicalId)
            ->value('js.shelf_id');

        if (! $shelfId) {
            return; // not a journal work, or the journal has no shelf yet
        }

        $this->reshelveOnShelf($shelfId, $canonicalId, $winner);
    }

    /**
     * The sibling swap itself, on an EXPLICIT shelf — also used by the
     * shelf-import console, whose collection shelf ("Cited by: …") is not
     * reachable through the work's own journal registration.
     */
    public function reshelveOnShelf(string $shelfId, string $canonicalId, string $winner): void
    {
        $db = DB::connection('pgsql_admin');

        $siblings = $db->table('library')
            ->where('canonical_source_id', $canonicalId)
            ->where('book', '!=', $winner)
            ->pluck('book');

        $removed = $siblings->isNotEmpty()
            ? $db->table('shelf_items')->where('shelf_id', $shelfId)->whereIn('book', $siblings)->delete()
            : 0;

        $added = 0;
        $onShelf = $db->table('shelf_items')
            ->where('shelf_id', $shelfId)->where('book', $winner)->exists();
        if (! $onShelf) {
            $db->table('shelf_items')->insert([
                'shelf_id' => $shelfId,
                'book'     => $winner,
                'added_at' => now(),
            ]);
            $added = 1;
        }

        if ($removed || $added) {
            app(ShelfCacheInvalidator::class)->flush($shelfId);
        }
    }

    private function refuse(string $reason): array
    {
        return ['promoted' => false, 'reason' => $reason, 'canonical_id' => null, 'demoted' => []];
    }
}
