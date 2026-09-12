<?php

namespace App\Services\CanonicalVersions;

use App\Services\LibraryCardGenerator;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Repair a work's publication year from the PUBLISHER'S OWN PAGE.
 *
 * OpenAlex carries wrong years for a meaningful slice of some journals, and the usual fix — ask
 * the DOI registry — does not work here, because the error is upstream of OpenAlex. tripleC's
 * `10.31269/triplec.v1i1.2` is deposited at Crossref as `issued: 1970-01-01`; OpenAlex copied that
 * faithfully. 1970-01-01 is the Unix epoch, i.e. a null date that was serialised as a real one
 * somewhere in the publisher's deposit pipeline, and it will keep coming back on every re-sync.
 *
 * The one source that has it right is the article page itself: that same work's OJS page carries
 * `<meta name="citation_date" content="2003">` plus volume 1, issue 1 — which is also what the DOI
 * string encodes. So the repair reads the page we ALREADY STORED when we imported the article
 * (`resources/markdown/{book}/fetched_page.html`), which makes this free, offline, and re-runnable.
 *
 * Evidence over heuristics, deliberately. A plausibility rule ("nothing before the journal started")
 * needs a journal start year we do not record, and would still only tell you a year is WRONG, never
 * what it should be. Comparing against the publisher's own metadata does both at once, so the
 * default mode checks every work that has a stored page rather than guessing which look suspect.
 */
class PublisherYearRepair
{
    /**
     * Meta tags that carry a publication date, best first.
     *
     * `citation_date` is what OJS emits and is the one that matters for this corpus;
     * `citation_publication_date` is the Highwire-standard spelling other platforms use. Both may
     * be a bare year, `YYYY/MM/DD`, or `YYYY-MM-DD`, hence the loose year extraction below.
     */
    private const DATE_META = [
        'citation_date',
        'citation_publication_date',
        'citation_cover_date',
        'citation_year',
        'DC.Date',
        'dc.date',
    ];

    public function __construct(private LibraryCardGenerator $cards)
    {
    }

    /**
     * Pull year / volume / issue out of a publisher page's citation meta tags.
     *
     * @return array{year: ?int, volume: ?string, issue: ?string}|null null when the page carries no date
     */
    public function extractFromPage(string $html): ?array
    {
        $year = null;
        foreach (self::DATE_META as $name) {
            $raw = $this->metaContent($html, $name);
            if ($raw === null) {
                continue;
            }
            // Any 4-digit year in the value. Deliberately not a date parse: the field is
            // inconsistently formatted across platforms and the year is the only part we use.
            if (preg_match('/\b(1[89]\d{2}|20\d{2})\b/', $raw, $m)) {
                $year = (int) $m[1];
                break;
            }
        }

        if ($year === null) {
            return null;
        }

        return [
            'year'   => $year,
            'volume' => $this->metaContent($html, 'citation_volume'),
            'issue'  => $this->metaContent($html, 'citation_issue'),
        ];
    }

    /** The stored publisher page for a book, if we kept one. */
    public function storedPageFor(string $book): ?string
    {
        $path = resource_path("markdown/{$book}/fetched_page.html");

        return File::exists($path) ? File::get($path) : null;
    }

    /**
     * Apply a corrected year (and volume/issue when the page supplied them) to a canonical and
     * every library row that is a version of it.
     *
     * The library rows have to be written EXPLICITLY. `HarvestShelf::syncJournalShelfMembership`
     * heals biblio fields from the canonical, but only into columns that are still empty — it is a
     * backfill for rows minted before those columns were copied, not a corrector. A row that
     * already carries the wrong year would keep it forever.
     *
     * Bibtex is patched for the same reason `patchBibtexFields` exists at all: cards render the
     * stored bibtex in PREFERENCE to the structured columns, so fixing only the columns leaves the
     * visible citation showing the old year.
     *
     * @param  array{year: int, volume: ?string, issue: ?string}  $found
     * @return int number of library rows updated
     */
    public function apply(string $canonicalId, array $found): int
    {
        $db = DB::connection('pgsql_admin');

        $update = ['year' => $found['year'], 'updated_at' => now()];
        // Volume/issue only FILL here, never overwrite: the year is the field we have positive
        // evidence is broken, and a publisher page's volume string is not obviously better than
        // what is already stored.
        foreach (['volume', 'issue'] as $field) {
            if (! empty($found[$field])) {
                $update[$field] = DB::raw(
                    "COALESCE(NULLIF({$field}, ''), " . $db->getPdo()->quote((string) $found[$field]) . ')'
                );
            }
        }
        $db->table('canonical_source')->where('id', $canonicalId)->update($update);

        $lanes = $db->table('library')
            ->where('canonical_source_id', $canonicalId)
            ->where('visibility', '!=', 'deleted')
            ->get(['book', 'bibtex']);

        foreach ($lanes as $lane) {
            $db->table('library')->where('book', $lane->book)->update([
                'year'       => (string) $found['year'],
                'bibtex'     => $lane->bibtex
                    ? $this->cards->patchBibtexFields($lane->bibtex, ['year' => (string) $found['year']])
                    : $lane->bibtex,
                'updated_at' => now(),
            ]);
        }

        return $lanes->count();
    }

    /** `<meta name="X" content="Y">` in either attribute order, case-insensitively. */
    private function metaContent(string $html, string $name): ?string
    {
        $n = preg_quote($name, '/');

        if (preg_match('/<meta[^>]+name\s*=\s*["\']' . $n . '["\'][^>]*content\s*=\s*["\']([^"\']*)["\']/i', $html, $m)) {
            return html_entity_decode(trim($m[1])) ?: null;
        }
        if (preg_match('/<meta[^>]+content\s*=\s*["\']([^"\']*)["\'][^>]*name\s*=\s*["\']' . $n . '["\']/i', $html, $m)) {
            return html_entity_decode(trim($m[1])) ?: null;
        }

        return null;
    }
}
