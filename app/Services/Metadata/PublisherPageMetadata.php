<?php

namespace App\Services\Metadata;

use Illuminate\Support\Facades\File;

/**
 * Read citation metadata out of a publisher's own article page.
 *
 * This is the ONE citation-meta scraper. It exists because the registries are not the authority
 * we wish they were: tripleC's `10.31269/triplec.v1i1.2` is deposited AT CROSSREF as
 * `issued: 1970-01-01` — the Unix epoch, a null date serialised as a real one somewhere in the
 * publisher's deposit pipeline — and OpenAlex copied it faithfully. Asking a DOI registry cannot
 * fix that, because the registry is where it starts. The article's own OJS page says
 * `citation_date: 2003`, correctly, and we already have that page on disk.
 *
 * Two things were previously true and are what this class fixes:
 *  - `ContentFetchService::extractScholarlyMetaTags()` read FOUR meta names (pdf_url, abstract,
 *    title, doi) off a page that also carries date, volume, issue, pages, authors, journal and
 *    ISSN. Everything else was parsed and thrown away on every single import.
 *  - `PublisherYearRepair::storedPageFor()` looked only for `fetched_page.html`, which is written
 *    only by the HTML lane's success path. A PDF-lane import saves the very same landing page as
 *    `original.html` (the legacy fetch writes it before deciding the page is abstract-only and
 *    downloading the PDF instead), so every PDF-lane work reported "no stored page" while its
 *    page sat on disk under a different name. `PAGE_FILENAMES` is that fix.
 *
 * Nothing here does network I/O. It reads a string, or a file we already kept.
 */
class PublisherPageMetadata
{
    /**
     * Stored copies of a publisher page, best first.
     *
     * `fetched_page.html` is the scrape lane's ground truth and `pasted_page.html` the paste
     * lane's, so both are a landing page by construction. `original.html` is ambiguous — for a
     * PDF-lane or legacy fetch it IS the landing page, but for the ar5iv lane it is the rendered
     * article — hence its position below the two unambiguous names. That ambiguity is safe rather
     * than merely tolerated: `extractFromPage()` returns null when a page carries no date meta,
     * and the drift detector only ever OVERWRITES a year that is already provably broken.
     * `rejected_page.html` is a condemned page kept as evidence; its meta tags are still the
     * publisher's, so it is a last resort rather than an exclusion.
     */
    public const PAGE_FILENAMES = [
        'fetched_page.html',
        'pasted_page.html',
        'original.html',
        'rejected_page.html',
    ];

    /**
     * Meta tags that carry a publication date, best first.
     *
     * `citation_date` is what OJS emits and is the one that matters for this corpus;
     * `citation_publication_date` is the Highwire-standard spelling other platforms use. Both may
     * be a bare year, `YYYY/MM/DD`, or `YYYY-MM-DD`, hence the loose year extraction below.
     */
    public const DATE_META = [
        'citation_date',
        'citation_publication_date',
        'citation_cover_date',
        'citation_year',
        'DC.Date',
        'dc.date',
    ];

    /** Single-valued citation tags worth keeping, keyed by the field we map them to. */
    private const SCALAR_META = [
        'title'      => 'citation_title',
        'volume'     => 'citation_volume',
        'issue'      => 'citation_issue',
        'first_page' => 'citation_firstpage',
        'last_page'  => 'citation_lastpage',
        'journal'    => 'citation_journal_title',
        'issn'       => 'citation_issn',
        'publisher'  => 'citation_publisher',
        'doi'        => 'citation_doi',
        'pdf_url'    => 'citation_pdf_url',
        'abstract'   => 'citation_abstract',
        'language'   => 'citation_language',
    ];

    /**
     * Everything the page will tell us about the work.
     *
     * @return array{
     *     year: ?int, title: ?string, authors: array<int, string>, volume: ?string, issue: ?string,
     *     first_page: ?string, last_page: ?string, pages: ?string, journal: ?string, issn: ?string,
     *     publisher: ?string, doi: ?string, pdf_url: ?string, abstract: ?string, language: ?string
     * }
     */
    public function extractAll(string $html): array
    {
        $out = ['year' => $this->year($html), 'authors' => $this->authors($html)];

        foreach (self::SCALAR_META as $field => $meta) {
            $out[$field] = $this->metaContent($html, $meta);
        }

        // A display range only when both ends are present — a lone first page is a start, not a
        // range, and joining it to nothing produces "1–" on the card.
        $out['pages'] = ($out['first_page'] && $out['last_page'])
            ? $out['first_page'] . '–' . $out['last_page']
            : null;

        return $out;
    }

    /**
     * The narrow year/volume/issue shape the year repair has always used.
     *
     * Kept as its own method (rather than folded into `extractAll`) because "did this page carry a
     * date at all" is the question the repair branches on, and null is a meaningful answer.
     *
     * @return array{year: int, volume: ?string, issue: ?string}|null null when the page carries no date
     */
    public function extractFromPage(string $html): ?array
    {
        $year = $this->year($html);

        if ($year === null) {
            return null;
        }

        return [
            'year'   => $year,
            'volume' => $this->metaContent($html, 'citation_volume'),
            'issue'  => $this->metaContent($html, 'citation_issue'),
        ];
    }

    /** The publication year from whichever date meta the page emits, best first. */
    public function year(string $html): ?int
    {
        foreach (self::DATE_META as $name) {
            $raw = $this->metaContent($html, $name);
            if ($raw === null) {
                continue;
            }
            // Any 4-digit year in the value. Deliberately not a date parse: the field is
            // inconsistently formatted across platforms and the year is the only part we use.
            if (preg_match('/\b(1[89]\d{2}|20\d{2})\b/', $raw, $m)) {
                return (int) $m[1];
            }
        }

        return null;
    }

    /**
     * Every `citation_author` on the page, in document order.
     *
     * Repeating tag, so this cannot go through `metaContent` (which answers "the first one").
     * Order matters — author position is part of a citation — and the full list is returned
     * deliberately: et-al truncation is a RENDER concern, never a storage one.
     *
     * @return array<int, string>
     */
    public function authors(string $html): array
    {
        $out = [];

        foreach (['citation_author', 'DC.Creator', 'dc.creator'] as $name) {
            $n = preg_quote($name, '/');
            foreach ([
                '/<meta[^>]+name\s*=\s*["\']' . $n . '["\'][^>]*content\s*=\s*["\']([^"\']*)["\']/i',
                '/<meta[^>]+content\s*=\s*["\']([^"\']*)["\'][^>]*name\s*=\s*["\']' . $n . '["\']/i',
            ] as $pattern) {
                if (preg_match_all($pattern, $html, $ms)) {
                    foreach ($ms[1] as $raw) {
                        $name_ = html_entity_decode(trim($raw), ENT_QUOTES, 'UTF-8');
                        if ($name_ !== '' && ! in_array($name_, $out, true)) {
                            $out[] = $name_;
                        }
                    }
                }
            }

            if ($out !== []) {
                break;
            }
        }

        return $out;
    }

    /**
     * The stored publisher page for a book, if we kept one under any of its names.
     *
     * Returns the first non-empty file in `PAGE_FILENAMES` order.
     */
    public function storedPageFor(string $book): ?string
    {
        foreach (self::PAGE_FILENAMES as $name) {
            $path = resource_path("markdown/{$book}/{$name}");
            if (File::exists($path)) {
                $html = File::get($path);
                if (trim($html) !== '') {
                    return $html;
                }
            }
        }

        return null;
    }

    /** Which file `storedPageFor` would read — for diagnostics and flag details. */
    public function storedPageNameFor(string $book): ?string
    {
        foreach (self::PAGE_FILENAMES as $name) {
            $path = resource_path("markdown/{$book}/{$name}");
            if (File::exists($path) && trim(File::get($path)) !== '') {
                return $name;
            }
        }

        return null;
    }

    /** `<meta name="X" content="Y">` in either attribute order, case-insensitively. */
    public function metaContent(string $html, string $name): ?string
    {
        $n = preg_quote($name, '/');

        if (preg_match('/<meta[^>]+name\s*=\s*["\']' . $n . '["\'][^>]*content\s*=\s*["\']([^"\']*)["\']/i', $html, $m)) {
            return html_entity_decode(trim($m[1]), ENT_QUOTES, 'UTF-8') ?: null;
        }
        if (preg_match('/<meta[^>]+content\s*=\s*["\']([^"\']*)["\'][^>]*name\s*=\s*["\']' . $n . '["\']/i', $html, $m)) {
            return html_entity_decode(trim($m[1]), ENT_QUOTES, 'UTF-8') ?: null;
        }

        return null;
    }
}
