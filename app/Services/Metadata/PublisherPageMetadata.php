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
        foreach (['citation_author', 'DC.Creator'] as $name) {
            $values = [];
            foreach ($this->metaValues($html, $name) as $value) {
                // De-duplicated because some templates emit the author block twice (once for
                // Highwire, once for Dublin Core) — but ORDER is preserved, since author position
                // is part of a citation.
                if (! in_array($value, $values, true)) {
                    $values[] = $value;
                }
            }
            if ($values !== []) {
                return $values;
            }
        }

        return [];
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

    /**
     * Values a publisher uses to mean "there isn't one yet", which must never be stored as if
     * they were one. Not a theoretical list: a 2026-09 corpus audit found Bristol UP emitting
     * `citation_volume: -1` and `citation_issue: aop` on an ahead-of-print article, and a naive
     * gap-fill would have written `volume = -1, issue = aop` onto the card.
     */
    private const NON_VALUES = [
        'aop', 'ahead of print', 'aheadofprint', 'online first', 'onlinefirst', 'in press',
        'inpress', 'forthcoming', 'preprint', 'n/a', 'na', 'none', 'null', 'nil', 'undefined',
        'tba', 'tbd', '-', '--',
    ];

    /**
     * Does this look like a real volume/issue designator?
     *
     * Deliberately a REJECT list plus a shape check rather than a strict numeric rule: real
     * designators are messily various ("12A", "Suppl 1", "Part 2", "1-2"), so demanding digits
     * would throw away good data. What must be excluded is the publisher's own way of saying
     * "unassigned" — a negative or zero number, or one of the placeholder words above.
     */
    public function isPlausibleDesignator(mixed $value): bool
    {
        $v = trim((string) $value);

        if ($v === '' || ! preg_match('/[a-z0-9]/i', $v)) {
            return false;
        }
        if (in_array(mb_strtolower($v), self::NON_VALUES, true)) {
            return false;
        }
        // A leading minus or an all-zero value is a sentinel, never a volume.
        if (preg_match('/^-/', $v) || preg_match('/^0+$/', $v)) {
            return false;
        }

        return true;
    }

    /**
     * Is this page actually the work we think it is?
     *
     * Asked BEFORE any of its metadata is allowed to overwrite the database, because
     * `storedPageFor()` returns whatever HTML is in the book's directory and not all of it is a
     * verified landing page for that article:
     *
     *  - `rejected_page.html` is written by three gates, and the ENGINE-CRASH one fires BEFORE
     *    `assessArticleAuthenticity` runs — so that page's identity was never checked by anyone.
     *  - `original.html` is the publisher landing page for a PDF/legacy fetch, but for the ar5iv
     *    lane it is the rendered ar5iv article: a different document class that may carry its own
     *    dates.
     *
     * Without this, a page belonging to a different work could "repair" a year that was merely
     * ugly into one that is confidently wrong — which is worse than the bug being fixed, because
     * a plausible wrong year is invisible to every downstream check.
     *
     * The rule mirrors `ContentFetchService::assessArticleAuthenticity`: a DOI match settles it
     * outright; failing that, the title has to be strongly similar. **No corroboration at all is
     * a refusal, not a pass** — an unidentifiable page does not get to rewrite citation data.
     *
     * @param  callable(string, string): float  $titleSimilarity
     * @return array{ok: bool, basis: string}
     */
    public function identityMatches(string $html, ?string $doi, ?string $title, callable $titleSimilarity): array
    {
        $norm = fn (string $d): string => strtolower(trim(preg_replace('#^https?://(dx\.)?doi\.org/#i', '', $d)));

        $pageDoi = $this->metaContent($html, 'citation_doi');
        if ($pageDoi && $doi) {
            return $norm($pageDoi) === $norm($doi)
                ? ['ok' => true,  'basis' => 'doi_match']
                : ['ok' => false, 'basis' => 'doi_mismatch'];
        }

        $pageTitle = $this->metaContent($html, 'citation_title');
        if ($pageTitle && $title) {
            $sim = $titleSimilarity($title, $pageTitle);

            return $sim >= 0.7
                ? ['ok' => true,  'basis' => 'title_match']
                : ['ok' => false, 'basis' => 'title_mismatch'];
        }

        return ['ok' => false, 'basis' => 'unidentifiable'];
    }

    /** The first `<meta name="X">` content on the page, or null. */
    public function metaContent(string $html, string $name): ?string
    {
        return $this->metaValues($html, $name)[0] ?? null;
    }

    /**
     * Every value for a meta name, in document order.
     *
     * Parsed with DOMDocument rather than matched with a regex, and scoped to `<head>`. A regex
     * over the raw page cannot tell a live tag from one inside an HTML comment or a `<script>`
     * template, and cannot tell the page's OWN citation tags from a "related articles" widget
     * embedding a different work's. The parser skips comments and script contents by
     * construction, and meta belongs in the head — so the widget case disappears rather than
     * being defended against.
     *
     * Falls back to the whole document only when the head carries no meta at all (a malformed
     * page where the parser put everything in the body); if there are head tags, they are the
     * page's own and nothing below competes with them.
     *
     * @return array<int, string>
     */
    public function metaValues(string $html, string $name): array
    {
        $out = [];
        foreach ($this->metaMap($html) as $key => $values) {
            // Meta names are case-insensitive in practice: `DC.Date` and `dc.date` are the same
            // tag, and publishers are inconsistent about which they emit.
            if (strcasecmp($key, $name) === 0) {
                $out = array_merge($out, $values);
            }
        }

        return $out;
    }

    /**
     * name => [values] for the page, parsed once.
     *
     * Memoised on the page's hash because `extractAll()` asks for a dozen names and reparsing a
     * 300KB publisher page each time would make an import-time check expensive. One entry: the
     * caller is always working through a single page before moving on.
     *
     * @return array<string, array<int, string>>
     */
    private function metaMap(string $html): array
    {
        $key = md5($html);
        if (($this->metaCacheKey ?? null) === $key) {
            return $this->metaCache;
        }

        $doc = new \DOMDocument();
        // The XML declaration forces UTF-8; without it libxml assumes ISO-8859-1 and mangles any
        // non-ASCII author name. Errors are suppressed because real publisher HTML is never valid
        // and we only want the tags it did manage to parse.
        $ok = @$doc->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NOERROR | LIBXML_NOWARNING);

        $map = [];
        if ($ok) {
            $xpath = new \DOMXPath($doc);
            $nodes = $xpath->query('//head//meta[@name][@content]');
            if ($nodes === false || $nodes->length === 0) {
                $nodes = $xpath->query('//meta[@name][@content]');
            }

            foreach ($nodes ?: [] as $node) {
                /** @var \DOMElement $node */
                // getAttribute returns the value already entity-decoded — do NOT decode again, or
                // a literal `&amp;` in a journal title becomes a bare `&`.
                $value = trim($node->getAttribute('content'));
                if ($value !== '') {
                    $map[$node->getAttribute('name')][] = $value;
                }
            }
        }

        $this->metaCacheKey = $key;
        $this->metaCache = $map;

        return $map;
    }

    /** @var array<string, array<int, string>> */
    private array $metaCache = [];

    private ?string $metaCacheKey = null;
}
