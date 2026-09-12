<?php

namespace App\Services\Metadata;

use App\Models\ConversionFlag;
use App\Services\CanonicalVersions\PublisherYearRepair;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Compare the citation metadata we STORED against what the publisher's own page says, correct the
 * cases where the stored value is provably broken, and flag the rest for a human.
 *
 * The split is the entire design, and it is deliberately conservative:
 *
 *  - **Correct silently** only when the stored value carries positive evidence of breakage — it
 *    is an epoch sentinel (1970), it is impossible for the journal (before the journal existed,
 *    or in the future), or the column is simply empty. There is nothing for a human to weigh
 *    here: 1970 for a journal founded in 2003 is not a competing opinion, it is a null date that
 *    got serialised as a real one in the publisher's deposit pipeline.
 *  - **Flag and touch nothing** when both values are plausible and merely differ — page says
 *    2004, OpenAlex says 2005. Picking a winner there trades a known bug for an unknown one, and
 *    the page is not automatically the better source for every field. A maintainer decides.
 *
 * Volume, issue and pages only ever FILL an empty column. The year is the one field we have
 * positive evidence is broken; a publisher page's volume string is not obviously better than what
 * is already stored, and overwriting it would be a guess wearing a repair's clothes.
 *
 * Where this runs: `ContentFetchService` captures the page's citation meta on EVERY import path
 * (journal, shelf, URL), so any import can call this. It is also what the offline repair uses,
 * reading the page we already kept on disk.
 */
class MetadataDriftDetector
{
    /**
     * Years that are a null date rather than a claim. 1970 is the Unix epoch, which is what
     * tripleC's Crossref deposit actually contains.
     */
    private const SENTINEL_YEARS = JournalYearFloor::SENTINEL_YEARS;

    public function __construct(
        private PublisherPageMetadata $page,
        private JournalYearFloor $floor,
        private PublisherYearRepair $repair,
    ) {
    }

    /**
     * Run the comparison for one canonical and act on it.
     *
     * @param  string  $canonicalId  the work
     * @param  ?string $html         the publisher page; null ⇒ read the stored one
     * @param  bool    $dryRun       decide and report, write nothing
     * @return array{
     *     status: 'no_page'|'no_date'|'agreed'|'corrected'|'flagged',
     *     fields: array<string, array{stored: mixed, page: mixed, action: string, rule: ?string}>,
     *     applied: array<string, mixed>, rows: int
     * }
     */
    public function inspect(string $canonicalId, ?string $html = null, bool $dryRun = false): array
    {
        $canonical = DB::connection('pgsql_admin')->table('canonical_source')
            ->where('id', $canonicalId)
            ->first(['id', 'year', 'volume', 'issue', 'journal_source_id', 'auto_version_book', 'title']);

        if (! $canonical) {
            return $this->result('no_page');
        }

        $html ??= $this->storedPageForCanonical($canonicalId, $canonical->auto_version_book);
        if ($html === null) {
            return $this->result('no_page');
        }

        $found = $this->page->extractAll($html);
        if ($found['year'] === null) {
            return $this->result('no_date');
        }

        $floor = $this->floor->floorFor($canonical->journal_source_id);
        $fields = $this->compare($canonical, $found, $floor);

        $applied = [];
        foreach ($fields as $field => $d) {
            if ($d['action'] === 'correct' || $d['action'] === 'fill') {
                $applied[$field] = $d['page'];
            }
        }

        $disputed = array_filter($fields, fn ($d) => $d['action'] === 'dispute');

        // `apply()` always writes a year, so it needs one that is real. When we are only filling
        // a volume and the stored year is null, there is nothing to anchor the write on — a cast
        // of null would persist year 0, inventing a worse value than the gap it filled.
        $yearToWrite = $applied['year'] ?? ($canonical->year !== null ? (int) $canonical->year : null);

        $rows = 0;
        if ($applied !== [] && $yearToWrite !== null && ! $dryRun) {
            // One write path, already correct: canonical + EVERY library version row + the
            // stored bibtex. The bibtex patch is not cosmetic — cards render bibtex in
            // preference to the structured columns, so fixing only the column leaves the
            // visible citation wrong.
            $rows = $this->repair->apply($canonicalId, [
                'year'   => (int) $yearToWrite,
                'volume' => $applied['volume'] ?? null,
                'issue'  => $applied['issue'] ?? null,
            ]);
        }

        if ($disputed !== [] && ! $dryRun) {
            $this->raiseFlag($canonicalId, $canonical, $fields, $disputed, $applied);
        }

        return [
            'status'  => $disputed !== [] ? 'flagged' : ($applied !== [] ? 'corrected' : 'agreed'),
            'fields'  => $fields,
            'applied' => $applied,
            'rows'    => $rows,
        ];
    }

    /**
     * Field-by-field verdicts.
     *
     * @return array<string, array{stored: mixed, page: mixed, action: string, rule: ?string}>
     */
    private function compare(object $canonical, array $found, ?int $floor): array
    {
        $fields = [];

        $storedYear = $canonical->year !== null ? (int) $canonical->year : null;
        $pageYear   = (int) $found['year'];

        if ($storedYear !== $pageYear) {
            // The page's own answer has to survive the same plausibility gate we judge the
            // stored value by — otherwise a junk page would "repair" a good year into a bad one.
            if ($this->floor->isImpossible($pageYear, $floor)) {
                $fields['year'] = $this->field($storedYear, $pageYear, 'reject_page', 'page_year_impossible');
            } elseif ($storedYear === null) {
                $fields['year'] = $this->field($storedYear, $pageYear, 'correct', 'stored_empty');
            } elseif (in_array($storedYear, self::SENTINEL_YEARS, true)) {
                $fields['year'] = $this->field($storedYear, $pageYear, 'correct', 'epoch_sentinel');
            } elseif ($this->floor->isImpossible($storedYear, $floor)) {
                $fields['year'] = $this->field($storedYear, $pageYear, 'correct', 'impossible_for_journal');
            } else {
                // Both plausible, and they differ. Not ours to settle.
                $fields['year'] = $this->field($storedYear, $pageYear, 'dispute', 'both_plausible');
            }
        }

        // Fill-only fields. A disagreement on these is worth surfacing but never worth writing:
        // we have no evidence the stored value is the broken one.
        foreach (['volume', 'issue'] as $field) {
            $stored = $canonical->$field;
            $pageValue = $found[$field] ?? null;
            if ($pageValue === null || (string) $pageValue === (string) $stored) {
                continue;
            }
            $fields[$field] = ($stored === null || $stored === '')
                ? $this->field($stored, $pageValue, 'fill', 'stored_empty')
                : $this->field($stored, $pageValue, 'dispute', 'both_present');
        }

        return $fields;
    }

    /** @return array{stored: mixed, page: mixed, action: string, rule: ?string} */
    private function field(mixed $stored, mixed $page, string $action, ?string $rule): array
    {
        return ['stored' => $stored, 'page' => $page, 'action' => $action, 'rule' => $rule];
    }

    /**
     * Raise (or fold into) the one open `metadata_drift` flag for this book.
     *
     * Flagged against the BOOK rather than the canonical because that is what both maintainer
     * consoles are keyed on — `BuildsImportLanes::openFlagCountsByBook()` surfaces it in the
     * journal-import and shelf-import lanes with no per-console work, and the existing
     * resolve/dismiss buttons close it.
     */
    private function raiseFlag(string $canonicalId, object $canonical, array $fields, array $disputed, array $applied): void
    {
        $books = DB::connection('pgsql_admin')->table('library')
            ->where('canonical_source_id', $canonicalId)
            ->where('visibility', '!=', 'deleted')
            ->pluck('book');

        if ($books->isEmpty()) {
            return;
        }

        $reason = 'Publisher page disagrees on ' . implode(', ', array_keys($disputed))
            . ' — ' . implode('; ', array_map(
                fn ($f, $d) => "{$f}: stored " . $this->show($d['stored']) . ', page ' . $this->show($d['page']),
                array_keys($disputed),
                $disputed,
            ));

        foreach ($books as $book) {
            ConversionFlag::raise($book, ConversionFlag::SOURCE_METADATA_DRIFT, $reason, [
                'canonical_source_id' => $canonicalId,
                'fields'              => $fields,
                'applied'             => $applied,
                'page_file'           => $canonical->auto_version_book
                    ? $this->page->storedPageNameFor($canonical->auto_version_book)
                    : null,
            ]);
        }

        Log::info('Metadata drift flagged', [
            'canonical' => $canonicalId,
            'disputed'  => array_keys($disputed),
            'books'     => $books->count(),
        ]);
    }

    /**
     * The stored page for a canonical, trying the pointed-at version first and then any other
     * library row for the work — the lanes are siblings, and only one of them may have kept a
     * landing page.
     */
    private function storedPageForCanonical(string $canonicalId, ?string $preferredBook): ?string
    {
        if ($preferredBook && ($html = $this->page->storedPageFor($preferredBook)) !== null) {
            return $html;
        }

        $books = DB::connection('pgsql_admin')->table('library')
            ->where('canonical_source_id', $canonicalId)
            ->where('visibility', '!=', 'deleted')
            ->pluck('book');

        foreach ($books as $book) {
            if ($book !== $preferredBook && ($html = $this->page->storedPageFor($book)) !== null) {
                return $html;
            }
        }

        return null;
    }

    private function show(mixed $v): string
    {
        return ($v === null || $v === '') ? '(empty)' : (string) $v;
    }

    /** @return array{status: string, fields: array, applied: array, rows: int} */
    private function result(string $status): array
    {
        return ['status' => $status, 'fields' => [], 'applied' => [], 'rows' => 0];
    }
}
