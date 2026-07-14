<?php

namespace App\Services\SourceHarvest;

use Illuminate\Support\Facades\DB;

/**
 * The single source of harvest-eligibility truth: which canonical_source rows
 * reached from a book's citations can legally be fetched and auto-versioned.
 *
 * A canonical is eligible when it has no auto_version_book yet, is open
 * access, and carries something fetchable (pdf_url / oa_url / doi) —
 * ContentFetchService's acquisition ladder takes it from there.
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
            ->orderByRaw('cs.cited_by_count DESC NULLS LAST')
            ->select('cs.*');

        if ($limit > 0) {
            $query->limit($limit);
        }

        return $query->get();
    }

    /**
     * Pure-SQL estimate for the confirm dialog. Before the first scan has
     * run, most entries are unresolved — the dialog copy must say so rather
     * than promising a number.
     *
     * @return array{total_entries: int, resolved: int, unresolved: int, eligible: int, already_harvested: int}
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
