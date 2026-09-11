<?php

namespace App\Services\SourceHarvest;

use Illuminate\Support\Facades\DB;

/**
 * The single source of harvest-eligibility truth: which canonical_source rows
 * reached from a book's citations can legally be fetched and auto-versioned.
 *
 * A canonical is eligible when it has no auto_version_book yet, is open
 * access, carries something fetchable (pdf_url / oa_url / doi), and is not
 * serving a retry cooldown from a previous failure — ContentFetchService's
 * acquisition ladder takes it from there.
 *
 * That last clause is the one that is easy to drop and expensive to lose: see
 * applyBackoff() and HarvestAttemptRecorder. Without it a failing work stays
 * eligible on identical terms forever and, because the queue is ordered
 * most-cited-first, re-runs at the FRONT of every batch — which on a journal
 * needing many time-boxed runs means the tail is never reached at all.
 *
 * Canonicals are reached two ways (footnotes have no canonical_source_id
 * column, so their path goes through the library stub):
 *   bibliography.canonical_source_id                      (direct)
 *   bibliography/footnotes.foundation_source → library.canonical_source_id
 *
 * Pure SQL, no network — the estimate endpoint calls this on every panel
 * open. (ContentFetchService::dryFetch is NOT usable here: it downloads.)
 */
class HarvestEligibility
{
    /**
     * Eligible canonicals for one book, most-cited first (they get harvested
     * first when the run hits its work budget).
     *
     * @return \Illuminate\Support\Collection<int, object> canonical_source rows
     */
    public function eligibleCanonicalsFor(string $book, int $limit = 0)
    {
        $query = DB::connection('pgsql_admin')
            ->table('canonical_source as cs')
            ->whereIn('cs.id', $this->reachedCanonicalIdsSubquery($book))
            ->whereNull('cs.auto_version_book')
            ->where('cs.is_oa', true)
            // NOTE: we deliberately do NOT exclude by OA colour. A bronze book
            // (a chapter / front-matter teaser) is still worth keeping — the fetch
            // ladder imports it and flags the version `partial` (see
            // ContentFetchService::assessCompleteness / AutoVersionCreator) so
            // citation review never treats it as the whole work. Only genuinely-
            // empty content is dropped (the post-OCR text floor).
            ->where(function ($q) {
                $q->where(fn ($q2) => $q2->whereNotNull('cs.pdf_url')->where('cs.pdf_url', '!=', ''))
                  ->orWhere(fn ($q2) => $q2->whereNotNull('cs.oa_url')->where('cs.oa_url', '!=', ''))
                  ->orWhere(fn ($q2) => $q2->whereNotNull('cs.doi')->where('cs.doi', '!=', ''));
            })
            ->tap(fn ($q) => $this->applyBackoff($q))
            ->select('cs.*');

        if ($limit > 0) {
            $query->limit($limit);
        }

        return $query->get();
    }

    /**
     * Eligible canonicals for one journal (journal_sources row), most-cited
     * first. Same predicate as eligibleCanonicalsFor but rooted on the
     * journal_source_id stamped at enumeration time instead of a book's
     * reached-citations subquery. Powers journal:harvest's select stage.
     *
     * @return \Illuminate\Support\Collection<int, object> canonical_source rows
     */
    public function eligibleCanonicalsForJournal(string $journalSourceId, int $limit = 0)
    {
        $query = DB::connection('pgsql_admin')
            ->table('canonical_source as cs')
            ->where('cs.journal_source_id', $journalSourceId)
            ->whereNull('cs.auto_version_book')
            ->where('cs.is_oa', true)
            // Same deliberate choice as eligibleCanonicalsFor: no OA-colour
            // exclusion — partial copies import flagged, empty ones get dropped
            // by the post-OCR text floor.
            ->where(function ($q) {
                $q->where(fn ($q2) => $q2->whereNotNull('cs.pdf_url')->where('cs.pdf_url', '!=', ''))
                  ->orWhere(fn ($q2) => $q2->whereNotNull('cs.oa_url')->where('cs.oa_url', '!=', ''))
                  ->orWhere(fn ($q2) => $q2->whereNotNull('cs.doi')->where('cs.doi', '!=', ''));
            })
            ->tap(fn ($q) => $this->applyBackoff($q))
            ->select('cs.*');

        if ($limit > 0) {
            $query->limit($limit);
        }

        return $query->get();
    }

    /**
     * The retry-backoff half of eligibility: skip works still cooling off after a failure, and
     * among those left prefer the ones we have never tried.
     *
     * Both clauses matter and for different reasons. The FILTER stops a dead work being re-fetched
     * every run (the browser rung burns its full 75s process timeout before giving up, so a handful
     * of corpses can eat a meaningful slice of a time-boxed batch). The ORDER stops a work that has
     * merely served its cooldown from jumping back ahead of never-attempted ones — without it, a
     * much-cited repeat failure reclaims the head of the queue the moment its stamp passes, which
     * is most of the original bug back again.
     *
     * `attempts ASC` before `cited_by_count DESC` therefore reads: everything untried, most cited
     * first; then everything once-failed, most cited first; and so on. The join is a LEFT one and
     * the sort key `COALESCE`d because the overwhelming majority of works have no row here at all —
     * a row is written only once something has actually failed.
     */
    private function applyBackoff($query): void
    {
        $query
            ->leftJoin('harvest_attempts as ha', function ($join) {
                $join->on('ha.canonical_source_id', '=', 'cs.id')
                    ->where('ha.lane', '=', HarvestAttemptRecorder::LANE_PDF);
            })
            ->where(function ($q) {
                $q->whereNull('ha.retry_after')->orWhere('ha.retry_after', '<=', now());
            })
            ->orderByRaw('COALESCE(ha.attempts, 0) ASC')
            ->orderByRaw('cs.cited_by_count DESC NULLS LAST');
    }

    /** Works of this journal currently serving a PDF-lane cooldown. */
    private function coolingOffForJournal(string $journalSourceId): int
    {
        return DB::connection('pgsql_admin')
            ->table('canonical_source as cs')
            ->join('harvest_attempts as ha', 'ha.canonical_source_id', '=', 'cs.id')
            ->where('cs.journal_source_id', $journalSourceId)
            ->whereNull('cs.auto_version_book')
            ->where('ha.lane', HarvestAttemptRecorder::LANE_PDF)
            ->where('ha.retry_after', '>', now())
            ->count();
    }

    /**
     * Pure-SQL pre-flight numbers for journal:harvest.
     *
     * `eligible` is what a run can act on RIGHT NOW, so it excludes works in their retry cooldown —
     * otherwise the console would promise 890 and the runner would find 883, and "remaining
     * eligible" would never reach zero on a journal with a few permanently-broken works. Those are
     * reported separately as `cooling_off` rather than hidden: they are not failures to act on, but
     * they are also not nothing, and an operator watching a number stall deserves to know which.
     *
     * @return array{total: int, eligible: int, cooling_off: int, already_harvested: int}
     */
    public function estimateForJournal(string $journalSourceId): array
    {
        $db = DB::connection('pgsql_admin');

        $base = $db->table('canonical_source')->where('journal_source_id', $journalSourceId);

        return [
            'total'             => (clone $base)->count(),
            'eligible'          => $this->eligibleCanonicalsForJournal($journalSourceId)->count(),
            'cooling_off'       => $this->coolingOffForJournal($journalSourceId),
            'already_harvested' => (clone $base)->whereNotNull('auto_version_book')->count(),
        ];
    }

    /**
     * The DURABLE harvested network for a root book: every canonical reachable
     * from the book's citations (recursively, through the version books it has
     * already imported) that now carries an auto_version_book — i.e. everything
     * that HAS been harvested, straight from the source of truth, independent of
     * any run's bookkeeping. This is what the yield report lists as "Harvested":
     * it self-heals across crashes and re-runs because it asks the database what
     * exists, not what a run happened to record.
     *
     * A BFS mirror of the harvester's own frontier walk, but over durable state:
     * book → its reached canonicals (harvested ones) → each one's version book →
     * that book's reached canonicals → … The visited-book set guards cycles;
     * walking until the frontier dries naturally respects the depth actually
     * scanned (a depth-1 harvest never scanned its version books, so they cite
     * nothing here and the walk stops). A hard cap bounds pathological networks.
     *
     * Each entry is shaped like a results-success row so the report renders it
     * with no special-casing: canonical metadata + status 'assigned' +
     * book (the version book) + parent_book + depth (BFS level, root = 0).
     *
     * @return array<int, array<string, mixed>> one entry per harvested canonical
     */
    public function harvestedNetworkFor(string $rootBook, int $maxBooks = 5000): array
    {
        $db = DB::connection('pgsql_admin');

        $entries = [];        // canonical_source_id => entry (dedup: first/shallowest wins)
        $visitedBooks = [$rootBook => true];
        $frontier = [['book' => $rootBook, 'depth' => 0]];
        $booksWalked = 0;

        while ($frontier && $booksWalked < $maxBooks) {
            $next = [];
            foreach ($frontier as $node) {
                $booksWalked++;
                $harvested = $db->table('canonical_source as cs')
                    ->whereIn('cs.id', $this->reachedCanonicalIdsSubquery($node['book']))
                    ->whereNotNull('cs.auto_version_book')
                    ->where('cs.auto_version_book', '!=', '')
                    ->select('cs.*')
                    ->get();

                foreach ($harvested as $cs) {
                    if (!isset($entries[$cs->id])) {
                        $entries[$cs->id] = [
                            'canonical_source_id' => $cs->id,
                            'title'          => $cs->title ?? null,
                            'author'         => $cs->author ?? null,
                            'year'           => $cs->year ?? null,
                            'journal'        => $cs->journal ?? null,
                            'publisher'      => $cs->publisher ?? null,
                            'type'           => $cs->type ?? null,
                            'doi'            => $cs->doi ?? null,
                            'openalex_id'    => $cs->openalex_id ?? null,
                            'oa_url'         => $cs->oa_url ?? null,
                            'pdf_url'        => $cs->pdf_url ?? null,
                            'cited_by_count' => $cs->cited_by_count ?? null,
                            'status'         => 'assigned',
                            'reason'         => null,
                            'via'            => null,
                            'book'           => $cs->auto_version_book,
                            'parent_book'    => $node['book'],
                            'depth'          => $node['depth'] + 1,
                        ];
                    }
                    // Descend into the version book's own citations (deeper harvest levels).
                    $versionBook = $cs->auto_version_book;
                    if ($versionBook && !isset($visitedBooks[$versionBook])) {
                        $visitedBooks[$versionBook] = true;
                        $next[] = ['book' => $versionBook, 'depth' => $node['depth'] + 1];
                    }
                }
            }
            $frontier = $next;
        }

        return array_values($entries);
    }

    /**
     * Pure-SQL estimate for the confirm dialog. Before the first scan has
     * run, most entries are unresolved — the dialog copy must say so rather
     * than promising a number.
     *
     * @return array{total_entries: int, resolved: int, unresolved: int, eligible: int, cooling_off: int, already_harvested: int}
     */
    public function estimateFor(string $book): array
    {
        $db = DB::connection('pgsql_admin');

        $bibTotal = $db->table('bibliography')->where('book', $book)->count();
        $fnTotal = $db->table('footnotes')
            ->where('book', $book)
            ->where('is_citation', true)
            ->count();

        $bibResolved = $db->table('bibliography as b')
            ->leftJoin('library as l', 'l.book', '=', 'b.foundation_source')
            ->where('b.book', $book)
            ->where(function ($q) {
                $q->whereNotNull('b.canonical_source_id')
                  ->orWhereNotNull('l.canonical_source_id');
            })
            ->count();

        $fnResolved = $db->table('footnotes as f')
            ->join('library as l', 'l.book', '=', 'f.foundation_source')
            ->where('f.book', $book)
            ->where('f.is_citation', true)
            ->whereNotNull('l.canonical_source_id')
            ->count();

        $reached = $this->reachedCanonicalIdsSubquery($book);

        $alreadyHarvested = $db->table('canonical_source as cs')
            ->whereIn('cs.id', $reached)
            ->whereNotNull('cs.auto_version_book')
            ->count();

        $total = $bibTotal + $fnTotal;
        $resolved = $bibResolved + $fnResolved;

        return [
            'total_entries'     => $total,
            'resolved'          => $resolved,
            'unresolved'        => max(0, $total - $resolved),
            'eligible'          => $this->eligibleCanonicalsFor($book)->count(),
            // Excluded from `eligible` by the backoff filter, but not gone — reported so a stalled
            // "remaining" number has a visible explanation rather than looking like a broken count.
            'cooling_off'       => $db->table('canonical_source as cs')
                ->join('harvest_attempts as ha', 'ha.canonical_source_id', '=', 'cs.id')
                ->whereIn('cs.id', $reached)
                ->whereNull('cs.auto_version_book')
                ->where('ha.lane', HarvestAttemptRecorder::LANE_PDF)
                ->where('ha.retry_after', '>', now())
                ->count(),
            'already_harvested' => $alreadyHarvested,
        ];
    }

    /**
     * Subquery of distinct canonical ids reachable from the book's citations
     * (bibliography direct + bibliography/footnote foundation_source stubs).
     */
    private function reachedCanonicalIdsSubquery(string $book)
    {
        $db = DB::connection('pgsql_admin');

        $direct = $db->table('bibliography')
            ->where('book', $book)
            ->whereNotNull('canonical_source_id')
            ->select('canonical_source_id');

        $viaBibStub = $db->table('bibliography as b')
            ->join('library as l', 'l.book', '=', 'b.foundation_source')
            ->where('b.book', $book)
            ->whereNotNull('l.canonical_source_id')
            ->select('l.canonical_source_id');

        $viaFootnoteStub = $db->table('footnotes as f')
            ->join('library as l', 'l.book', '=', 'f.foundation_source')
            ->where('f.book', $book)
            ->where('f.is_citation', true)
            ->whereNotNull('l.canonical_source_id')
            ->select('l.canonical_source_id');

        return $direct->union($viaBibStub)->union($viaFootnoteStub);
    }
}
