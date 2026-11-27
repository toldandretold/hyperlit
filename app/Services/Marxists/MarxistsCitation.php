<?php

namespace App\Services\Marxists;

use App\Services\CanonicalVersions\AutoVersionResolver;
use Illuminate\Support\Facades\DB;

/**
 * Writes what `MarxistsWorkClassifier` decided onto a book: `library.type` / `journal` / `year`,
 * and the ledger's `genre`. One writer, used by both import lanes as a work lands and by
 * `marxists:classify` for the books imported before any of this existed.
 *
 * The evidence is the stitcher's own record of the crawl, `marxists_provenance.json` (the
 * information block and the page list), kept beside the book — so nothing here asks the site
 * for anything, and a reclassification after a rule change costs no requests.
 *
 * It never overrules a person: a row whose type or periodical someone has already set is left
 * alone, and a user's own import is only touched while it still carries the import's default.
 */
class MarxistsCitation
{
    /** What an unclassified marxists.org import was born with — the only type this may replace. */
    private const UNTOUCHED_TYPE = 'book';

    /**
     * What classifying this book would change. Null when there is nothing to go on (no
     * provenance file — not a marxists.org stitch, or its artifacts are gone).
     *
     * @return array{book: string, genre: string, reason: string, changes: array<string, array{0: mixed, 1: mixed}>, skipped: ?string}|null
     */
    public function plan(string $book): ?array
    {
        $provenance = $this->provenance($book);
        $row = $this->db()->table('library')->where('book', $book)->first(['book', 'title', 'type', 'journal', 'year', 'url', 'note', 'creator']);
        if ($provenance === null || ! $row) {
            return null;
        }

        $info = array_filter((array) ($provenance['metadata']['info'] ?? []), 'is_string');
        $verdict = MarxistsWorkClassifier::classify(
            (string) ($provenance['index_url'] ?? $row->url),
            (string) ($provenance['metadata']['title'] ?? $row->title),
            $info,
            max(1, count((array) ($provenance['pages'] ?? []))),
        );

        $plan = ['book' => $book, 'genre' => $verdict['genre'], 'reason' => $verdict['reason'], 'changes' => [], 'skipped' => null];
        // Ours to set while the row still holds the import's default, or what an earlier run of
        // this very classifier wrote (the ledger remembers) — so a rule change can be re-applied.
        $ours = $this->db()->table('marxists_works')->where('book', $book)->value('genre');
        $untouched = (string) $row->type === self::UNTOUCHED_TYPE
            || ($ours !== null && (string) $row->type === (MarxistsWorkClassifier::TYPE_OF[$ours] ?? null));
        if (! $untouched) {
            $plan['skipped'] = "type already set by hand ({$row->type})";

            return $plan;
        }

        if ($verdict['type'] !== $row->type) {
            $plan['changes']['type'] = [$row->type, $verdict['type']];
        }
        // A periodical someone typed in is never replaced.
        if ($verdict['journal'] !== null && trim((string) $row->journal) === '') {
            $plan['changes']['journal'] = [$row->journal, $verdict['journal']];
        }
        // Only a system-minted row's year: on a person's own import the year is theirs to state.
        if ($verdict['year'] !== null && (int) $row->year !== $verdict['year'] && $row->creator === AutoVersionResolver::CREATOR) {
            $plan['changes']['year'] = [$row->year, $verdict['year']];
        }
        $clean = self::cleanNote((string) $row->note);
        if ($clean !== (string) $row->note) {
            $plan['changes']['note'] = [mb_strimwidth((string) $row->note, 0, 60, '…'), mb_strimwidth($clean, 0, 60, '…')];
            $plan['note'] = $clean;
        }

        return $plan;
    }

    /**
     * Classify one book and write the result. Returns the plan that was applied (or null).
     *
     * The library row's content clock is NOT moved: this changes how the book is cited, not what
     * it says, and a moved clock costs the book its prerender (and a syncing owner a 409).
     */
    public function apply(string $book): ?array
    {
        $plan = $this->plan($book);
        if ($plan === null) {
            return null;
        }

        $this->db()->table('marxists_works')->where('book', $book)->update(['genre' => $plan['genre']]);

        $set = [];
        foreach ($plan['changes'] as $column => [, $to]) {
            $set[$column] = $column === 'note' ? $plan['note'] : $to;
        }
        if ($set !== []) {
            // `meta_updated_at` moves by its own trigger, which is what refreshes the feeds' cards.
            $this->db()->table('library')->where('book', $book)->update($set);
        }

        return $plan;
    }

    /**
     * "Written: : 1863 | Source: : Theories…" — the note is the information block joined up, and
     * every value used to keep the colon that stood outside its label. Also drops a footnote
     * that was read as a field ("4: A reference to the rule in India…").
     */
    public static function cleanNote(string $note): string
    {
        $fields = [];
        foreach (explode(' | ', $note) as $field) {
            [$label, $value] = array_pad(explode(': ', $field, 2), 2, '');
            if (! preg_match('/[A-Za-z]{3}/', $label)) {
                continue;
            }
            $value = trim(ltrim(trim($value), ':'));
            $fields[] = $value === '' ? trim($label) : trim($label) . ': ' . $value;
        }

        return implode(' | ', $fields);
    }

    private function provenance(string $book): ?array
    {
        $path = resource_path("markdown/{$book}/marxists_provenance.json");
        $data = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;

        return is_array($data) ? $data : null;
    }

    private function db()
    {
        return DB::connection('pgsql_admin');
    }
}
