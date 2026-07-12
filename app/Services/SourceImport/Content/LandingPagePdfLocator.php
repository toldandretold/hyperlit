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
