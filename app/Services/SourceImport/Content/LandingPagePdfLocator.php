<?php

namespace App\Services\SourceImport\Content;

use App\Services\ContentFetchService;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Finds the actual PDF on a repository / handle / article LANDING page —
 * DSpace, EPrints, hdl.handle.net, or a publisher article page. Repository
 * landings used to get paste-engine-scraped into an UNVERIFIED html copy
 * (which never becomes a canonical version → the "deferred" harvest misses);
 * this pulls the real PDF instead, so it goes down the proper OCR lane.
 *
 * Extraction order: the citation_pdf_url meta tag (the scholarly standard),
 * then a small set of repository URL patterns (DSpace /bitstream/, EPrints,
 * generic .pdf anchors). Pure HTTP (no browser) — the browser tail still
 * handles pages this can't crack.
 */
class LandingPagePdfLocator
{
    /**
     * @return string|null absolute PDF URL, or null if none discoverable
     */
    public function locate(string $landingUrl): ?string
    {
        $html = $this->fetchHtml($landingUrl);
        if ($html === null) {
            return null;
        }
        return $this->extractFromHtml($html, $landingUrl);
    }

    /**
     * Given already-fetched landing HTML (e.g. from FlareSolverr), find the PDF.
     */
    public function extractFromHtml(string $html, string $baseUrl): ?string
    {
        // 1. citation_pdf_url meta tag — the Highwire/Google Scholar standard.
        if (preg_match('/<meta\s+[^>]*name=["\']citation_pdf_url["\']\s+[^>]*content=["\']([^"\']+)["\']/is', $html, $m)
            || preg_match('/<meta\s+[^>]*content=["\']([^"\']+)["\']\s+[^>]*name=["\']citation_pdf_url["\']/is', $html, $m)) {
            return $this->absolutise(html_entity_decode(trim($m[1]), ENT_QUOTES, 'UTF-8'), $baseUrl);
        }

        // 2. DSpace bitstream / EPrints / generic .pdf anchors.
        //    Prefer links that look like a full-text bitstream.
        if (preg_match_all('/<a\s+[^>]*href=["\']([^"\']+)["\']/is', $html, $all)) {
            $hrefs = $all[1];
            // Rank: bitstream PDFs first, then any .pdf.
            usort($hrefs, function ($a, $b) {
                return $this->pdfHrefScore($b) <=> $this->pdfHrefScore($a);
            });
            foreach ($hrefs as $href) {
                if ($this->pdfHrefScore($href) > 0) {
                    return $this->absolutise(html_entity_decode(trim($href), ENT_QUOTES, 'UTF-8'), $baseUrl);
                }
            }
        }

        return null;
    }

    /** Higher = more likely a full-text PDF link. 0 = not a PDF link. */
    private function pdfHrefScore(string $href): int
    {
        $l = strtolower($href);
        $path = strtolower((string) parse_url($href, PHP_URL_PATH));
        if (str_contains($l, '/bitstream/') && str_ends_with($path, '.pdf')) return 3; // DSpace full text
        if (str_contains($l, 'viewcontent.cgi')) return 3;                              // bepress/Digital Commons
        if (str_contains($l, '/download')) return 2;
        if (str_ends_with($path, '.pdf')) return 2;
        if (str_contains($path, '.pdf')) return 1;
        return 0;
    }

    /**
     * Pick the PDF on a landing page for CITATION resolution.
     *
     * Separate from extractFromHtml() rather than a change to its ranking,
     * because that one chooses which PDF a canonical VERSION is minted from and
     * harvest depends on its current behaviour. This variant adds what a cited
     * gov/IGO report needs and a journal article does not:
     *
     *  - LANGUAGE. Institutional publishers post the same document in six
     *    languages off one page (the UN is the standard case), and we can only
     *    verify a claim against the language we can read. A filename or path
     *    naming a non-English language is demoted below an unmarked one; an
     *    explicitly English one is promoted above both.
     *  - Government/NGO publishing paths (`/sites/default/files/`,
     *    `/wp-content/uploads/`, `/documents/`), which are not repository
     *    patterns and so score 0 on the harvest ladder beyond the bare `.pdf`.
     *  - Front matter is refused outright via the shared shape check, so a
     *    cover or a table of contents cannot win.
     */
    public function locateForCitation(string $html, string $baseUrl, string $language = 'en'): ?string
    {
        if (! preg_match_all('/<a\s+[^>]*href=["\']([^"\']+)["\']/is', $html, $all)) {
            return null;
        }

        $best = null;
        $bestScore = 0;

        foreach (array_unique($all[1]) as $href) {
            $href = html_entity_decode(trim($href), ENT_QUOTES, 'UTF-8');
            $base = $this->pdfHrefScore($href);
            if ($base === 0) {
                $base = $this->institutionalPdfScore($href);
            }
            if ($base === 0 || ContentFetchService::isFrontMatterUrl($href)) {
                continue;
            }

            // Scale so the language signal orders candidates of equal kind
            // without ever letting a wrong-language file outrank a genuinely
            // better one.
            $score = $base * 10 + $this->languageScore($href, $language);
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $href;
            }
        }

        return $best === null ? null : $this->absolutise($best, $baseUrl);
    }

    /**
     * Publishing paths used by governments, IGOs and NGOs. The harvest ladder
     * knows repositories (DSpace, EPrints, bepress); these are the shapes a
     * cited report actually lives at.
     */
    private function institutionalPdfScore(string $href): int
    {
        $path = strtolower((string) parse_url($href, PHP_URL_PATH));
        if (! str_contains($path, '.pdf')) {
            return 0;
        }

        foreach (['/sites/default/files/', '/wp-content/uploads/', '/documents/', '/publications/', '/files/', '/media/'] as $needle) {
            if (str_contains($path, $needle)) {
                return 2;
            }
        }

        return 1;
    }

    /**
     * +2 explicitly English, 0 unmarked, -1 explicitly another language.
     * Unmarked sits ABOVE a foreign file and BELOW a declared English one: a
     * plain `report.pdf` is usually the English original, but we should not
     * prefer a guess over a statement.
     */
    private function languageScore(string $href, string $language): int
    {
        $l = strtolower($href);

        if (preg_match('#(^|[/_.-])' . preg_quote($language, '#') . '([/_.-]|$)#', $l)
            || str_contains($l, 'english')) {
            return 2;
        }

        // Only the languages institutional publishers actually parallel-post,
        // and only as a delimited token, so "Francesca" or "/research/" cannot
        // be mistaken for French or Russian.
        foreach (['fr', 'es', 'ar', 'ru', 'zh', 'de', 'pt', 'it', 'ja', 'ko', 'hi'] as $other) {
            if ($other === $language) {
                continue;
            }
            if (preg_match('#(^|[/_.-])' . $other . '([/_.-]|$)#', $l)) {
                return -1;
            }
        }

        foreach (['french', 'spanish', 'arabic', 'russian', 'chinese', 'german', 'portuguese'] as $named) {
            if (str_contains($l, $named)) {
                return -1;
            }
        }

        return 0;
    }

    /** Resolve a possibly-relative href against the landing page URL. */
    private function absolutise(string $href, string $baseUrl): ?string
    {
        if (preg_match('#^https?://#i', $href)) {
            return $href;
        }
        $scheme = parse_url($baseUrl, PHP_URL_SCHEME) ?: 'https';
        $host = parse_url($baseUrl, PHP_URL_HOST);
        if (!$host) {
            return null;
        }
        if (str_starts_with($href, '//')) {
            return $scheme . ':' . $href;
        }
        if (str_starts_with($href, '/')) {
            return $scheme . '://' . $host . $href;
        }
        // Relative to the landing directory.
        $basePath = rtrim(dirname((string) parse_url($baseUrl, PHP_URL_PATH)), '/');
        return $scheme . '://' . $host . $basePath . '/' . $href;
    }

    private function fetchHtml(string $url): ?string
    {
        try {
            $resp = Http::withHeaders(ContentFetchService::browserHeaders())
                ->withOptions(array_merge(['allow_redirects' => ['max' => 5]], ContentFetchService::fetchProxy()))
                ->timeout(20)
                ->get($url);
            if (!$resp->successful()) {
                return null;
            }
            $ct = strtolower($resp->header('Content-Type') ?? '');
            if ($ct && !str_contains($ct, 'html')) {
                return null; // not an HTML landing page
            }
            return $resp->body();
        } catch (\Throwable $e) {
            Log::warning('LandingPagePdfLocator fetch failed', ['url' => $url, 'error' => $e->getMessage()]);
            return null;
        }
    }
}
