<?php

namespace App\Services\Footnotes;

use Illuminate\Support\Facades\DB;

/**
 * Which works a citation footnote was matched to — for the reader's footnote popup.
 *
 * The scan (CitationScanBibliographyJob) records a footnote's match as `foundation_source`
 * (the matched work's library row; 'unknown' = searched, nothing found), and for a footnote
 * citing several works ("report; journal article") each further work under
 * `llm_metadata.sub_citations[i].resolution`. Short-form ("Ibid.") and pointer footnotes
 * inherit their antecedent's `foundation_source`, so they resolve here like any other.
 *
 * Returned as canonical_source ids — the same identity a bibliography reference carries — so
 * the client resolves each through /api/canonical/{id}/best-version, which applies the
 * per-viewer visibility rules; a cited WEB page has no canonical and is returned as its
 * original url + title instead. Nothing here is a book id or body text.
 *
 * Reads on pgsql_admin: the matched rows are system stubs, often private (held for review),
 * which the RLS'd connection hides — and this is also called from BookCache's queue-side warm.
 * The caller has already authorised the BOOK; a canonical id is public bibliographic identity.
 *
 * ONE definition, used by both the live load path (DatabaseToIndexedDBController::getFootnotes)
 * and its cache mirror (BookCache::buildFootnotes) so the two cannot drift.
 */
final class FootnoteSources
{
    /**
     * @return array<string, list<array<string, ?string>>>  footnoteId => matched works in citation
     *         order, each `{canonical_source_id}` or `{url, title}`. Unmatched footnotes are absent.
     */
    public static function forBook(string $bookId): array
    {
        $db = DB::connection('pgsql_admin');

        $rows = $db->table('footnotes')
            ->where('book', $bookId)
            ->where('is_citation', true)
            ->get(['footnoteId', 'foundation_source', 'llm_metadata']);
        if ($rows->isEmpty()) {
            return [];
        }

        // footnoteId => matched library rows, primary first then each matched sub-citation.
        $booksByFootnote = [];
        foreach ($rows as $row) {
            $books = [];
            if (! empty($row->foundation_source) && $row->foundation_source !== 'unknown') {
                $books[] = (string) $row->foundation_source;
            }
            foreach (self::decode($row->llm_metadata)['sub_citations'] ?? [] as $sub) {
                $resolution = is_array($sub) ? ($sub['resolution'] ?? null) : null;
                if (is_array($resolution) && ($resolution['status'] ?? null) === 'matched' && ! empty($resolution['book'])) {
                    $books[] = (string) $resolution['book'];
                }
            }
            if ($books) {
                $booksByFootnote[$row->footnoteId] = $books;
            }
        }
        if (! $booksByFootnote) {
            return [];
        }

        $rowsByBook = $db->table('library')
            ->whereIn('book', array_values(array_unique(array_merge(...array_values($booksByFootnote)))))
            ->get(['book', 'canonical_source_id', 'url', 'title'])
            ->keyBy('book');

        $out = [];
        foreach ($booksByFootnote as $footnoteId => $books) {
            $entries = [];
            foreach ($books as $book) {
                $entry = self::entryFor($rowsByBook[$book] ?? null);
                if ($entry) {
                    // keyed so the same work reached twice (primary + a sub) is listed once
                    $entries[$entry['canonical_source_id'] ?? $entry['url']] ??= $entry;
                }
            }
            if ($entries) {
                $out[$footnoteId] = array_values($entries);
            }
        }

        return $out;
    }

    /**
     * A matched library row as the reader needs it: its canonical identity when it has one,
     * otherwise — a WEB page the footnote cites, which WebFetchService mints with no canonical —
     * the ORIGINAL url and the page's title. Never the row's own book id: a web stub is private
     * evidence held for citation review, and readers are linked to the original (HostingPolicy).
     *
     * @return array{canonical_source_id:string}|array{url:string,title:?string}|null
     */
    private static function entryFor(?object $row): ?array
    {
        if (! $row) {
            return null;
        }
        if (! empty($row->canonical_source_id)) {
            return ['canonical_source_id' => (string) $row->canonical_source_id];
        }
        $url = trim((string) ($row->url ?? ''));
        if (preg_match('#^https?://#i', $url)) {
            $title = trim((string) ($row->title ?? ''));

            return ['url' => $url, 'title' => ($title === '' || $title === 'Web Source') ? null : $title];
        }

        return null;
    }

    /** llm_metadata is jsonb, and some legacy rows hold a JSON string inside it (double-encoded). */
    private static function decode(mixed $raw): array
    {
        for ($i = 0; $i < 2 && is_string($raw); $i++) {
            $raw = json_decode($raw, true);
        }

        return is_array($raw) ? $raw : [];
    }
}
