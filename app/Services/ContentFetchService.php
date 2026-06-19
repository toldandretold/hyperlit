<?php

namespace App\Services;

use App\Helpers\SubBookIdHelper;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\PdfProcessor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class ContentFetchService
{
    private FileHelpers $fileHelpers;
    private HtmlProcessor $htmlProcessor;
    private PdfProcessor $pdfProcessor;
    private LlmService $llmService;

    public function __construct(FileHelpers $fileHelpers, HtmlProcessor $htmlProcessor, PdfProcessor $pdfProcessor, LlmService $llmService)
    {
        $this->fileHelpers = $fileHelpers;
        $this->htmlProcessor = $htmlProcessor;
        $this->pdfProcessor = $pdfProcessor;
        $this->llmService = $llmService;
    }

    /**
     * Dry-run fetch: download HTML and save to disk, skip processing.
     *
     * @return array{status: string, reason: string, file_path: ?string, content_length: ?int, content_type: ?string}
     */
    public function dryFetch(object $libraryRecord): array
    {
        $bookId = $libraryRecord->book;
        $oaUrl = $libraryRecord->oa_url ?? null;
        $pdfUrl = $libraryRecord->pdf_url ?? null;

        $url = $oaUrl ?: $pdfUrl;
        if (!$url) {
            return [
                'status' => 'skipped',
                'reason' => 'No fetchable URL (no oa_url or pdf_url)',
                'file_path' => null,
                'content_length' => null,
                'content_type' => null,
            ];
        }

        $path = resource_path("markdown/{$bookId}");

        try {
            $response = Http::withHeaders(self::browserHeaders())
                ->timeout(30)->get($url);

            if (!$response->successful()) {
                return [
                    'status' => 'failed',
                    'reason' => "HTTP {$response->status()} fetching {$url}",
                    'file_path' => null,
                    'content_length' => null,
                    'content_type' => null,
                ];
            }

            $body = $response->body();
            $contentType = $response->header('Content-Type') ?? 'unknown';

            if (!File::exists($path)) {
                File::makeDirectory($path, 0755, true);
            }

            $htmlPath = "{$path}/original.html";
            File::put($htmlPath, $body);

            return [
                'status' => 'dry_run',
                'reason' => 'HTML saved (dry-run, processing skipped)',
                'file_path' => $htmlPath,
                'content_length' => strlen($body),
                'content_type' => $contentType,
            ];

        } catch (\Exception $e) {
            Log::error('ContentFetchService::dryFetch failed', [
                'book' => $bookId,
                'url' => $url,
                'error' => $e->getMessage(),
            ]);

            return [
                'status' => 'failed',
                'reason' => $e->getMessage(),
                'file_path' => null,
                'content_length' => null,
                'content_type' => null,
            ];
        }
    }

    /**
     * Fetch and import content for a library record.
     *
     * @return array{status: string, reason: string}
     */
    public function fetch(object $libraryRecord): array
    {
        $bookId = $libraryRecord->book;
        $oaUrl = $libraryRecord->oa_url ?? null;
        $pdfUrl = $libraryRecord->pdf_url ?? null;
        $doi = $libraryRecord->doi ?? null;

        $lastFailure = null;

        // Strategy 0: JATS / NLM full text (authoritative + structured +
        // cheap, no OCR). The publisher's own marked-up text — body and
        // references are schema-labelled, so "did we get the whole article?"
        // is a fact, not a guess. PMC open-access subset only; restricted
        // papers fall through to the PDF/browser ladder below.
        if ($doi) {
            $result = $this->fetchJatsFullText($doi, $bookId);
            if ($result['status'] !== 'failed') {
                return $result;
            }
            // Soft miss (no OA JATS) — don't record as the failure reason,
            // the cheaper-than-PDF probe just didn't apply.
        }

        // Strategy 1: oa_url looks like a PDF → downloadPdf
        if ($oaUrl && $this->looksLikePdf($oaUrl)) {
            $result = $this->downloadPdf($oaUrl, $bookId, $doi);
            if ($result['status'] !== 'failed') {
                return $result;
            }
            $lastFailure = $result['reason'];
            // Reset pdf_url_status so later strategies aren't blocked
            $this->setPdfUrlStatus($bookId, null);
        }

        // Strategy 2: oa_url as HTML
        if ($oaUrl && !$this->looksLikePdf($oaUrl)) {
            $result = $this->fetchHtml($oaUrl, $bookId);
            if ($result['status'] !== 'failed') {
                return $result;
            }
            $lastFailure = $result['reason'];
        }

        // Strategy 3: pdf_url (if different from oa_url)
        if ($pdfUrl && $pdfUrl !== $oaUrl) {
            $result = $this->downloadPdf($pdfUrl, $bookId, $doi);
            if ($result['status'] !== 'failed') {
                return $result;
            }
            $lastFailure = $result['reason'];
            // Reset pdf_url_status so DOI strategy isn't blocked
            $this->setPdfUrlStatus($bookId, null);
        }

        // Strategy 4: Semantic Scholar open-access PDF discovery by DOI.
        // Catches legal repository copies (PubMed Central etc.) that
        // OpenAlex's OA snapshot misses — those serve to a plain HTTP client,
        // where publisher landing pages (strategy 5) sit behind bot walls.
        if ($doi) {
            $s2Pdf = app(SemanticScholarService::class)->openAccessPdfByDoi($doi);
            if ($s2Pdf && $s2Pdf !== $pdfUrl && $s2Pdf !== $oaUrl) {
                $result = $this->downloadPdf($s2Pdf, $bookId, $doi);
                if ($result['status'] !== 'failed') {
                    // Persist the discovered URL so retries/provenance see it
                    DB::connection('pgsql_admin')->table('library')
                        ->where('book', $bookId)
                        ->update(['pdf_url' => $s2Pdf, 'updated_at' => now()]);
                    return $result;
                }
                $lastFailure = $result['reason'];
                $this->setPdfUrlStatus($bookId, null);
            }
        }

        // Strategy 5: Crossref-deposited full-text links (publisher TDM /
        // syndication deposits). Often CDN-hosted and fetchable even when the
        // landing page is walled — though some publishers (MIT Press) wall
        // these too; each is just one cheap attempt.
        if ($doi) {
            foreach ($this->crossrefPdfLinks($doi) as $crUrl) {
                if ($crUrl === $pdfUrl || $crUrl === $oaUrl) {
                    continue;
                }
                $result = $this->downloadPdf($crUrl, $bookId, $doi);
                if ($result['status'] !== 'failed') {
                    DB::connection('pgsql_admin')->table('library')
                        ->where('book', $bookId)
                        ->update(['pdf_url' => $crUrl, 'updated_at' => now()]);
                    return $result;
                }
                $lastFailure = $result['reason'];
                $this->setPdfUrlStatus($bookId, null);
            }
        }

        // Strategy 6: DOI resolution as HTML
        if ($doi) {
            $doiUrl = 'https://doi.org/' . $doi;
            $result = $this->fetchHtml($doiUrl, $bookId);
            if ($result['status'] !== 'failed') {
                return $result;
            }
            $lastFailure = $result['reason'];
        }

        // Strategy 7: headless browser (Playwright) — the same machinery the
        // URL-import pathway uses (scripts/fetch-pdf.mjs): clears JS
        // challenges, scrapes citation_pdf_url from the landing page, carries
        // session cookies. True last resort — a browser per source is the
        // expensive path — but it's the only way into "CC-BY-but-walled"
        // publishers (direct.mit.edu et al.) where every discovery service
        // points at a bot-walled URL.
        if ($doi || $pdfUrl || $oaUrl) {
            $landing = $doi ? ('https://doi.org/' . $doi) : ($oaUrl ?: $pdfUrl);
            $target  = $pdfUrl ?: $landing;
            $result = $this->fetchPdfViaBrowser($target, $landing, $bookId);
            if ($result['status'] !== 'failed') {
                return $result;
            }
            $lastFailure = $result['reason'];
        }

        // Strategy 8: browser-fetch the article HTML PAGE → paste engine.
        // The publisher's reading view often clears the bot wall its PDF
        // endpoint doesn't (proven: direct.mit.edu HTML 200 vs PDF 403). The
        // paste engine — purpose-built for journal HTML — converts it to
        // app-native dynamic citations. Gated so a non-article page can't
        // become a canonical version.
        if ($doi || $oaUrl) {
            $pageUrl = $doi ? ('https://doi.org/' . $doi) : $oaUrl;
            $html = $this->fetchHtmlViaBrowser($pageUrl);
            if ($html !== null) {
                $result = $this->importViaPasteEngine($html, $bookId, $pageUrl);
                if ($result['status'] !== 'failed') {
                    return $result;
                }
                $lastFailure = $result['reason'];
            }
        }

        // All strategies exhausted
        if ($lastFailure) {
            $this->setPdfUrlStatus($bookId, $lastFailure);
            return ['status' => 'failed', 'reason' => $lastFailure];
        }

        return [
            'status' => 'skipped',
            'reason' => 'No fetchable URL (no oa_url, pdf_url, or doi)',
        ];
    }

    /**
     * Fetch + import JATS full text for a DOI. Authoritative path: structured
     * publisher XML → app-native linked HTML (exact xref→ref links, no fuzzy
     * detection — JATS declares every link) → the shared persistArticle. No
     * gate needed: fetched BY DOI from PMC (identity certain) and schema-
     * complete (body + ref-list labelled). Tagged conversion_method=
     * 'jats_fulltext' (canonical-eligible). 'imported' on success.
     */
    private function fetchJatsFullText(string $doi, string $bookId): array
    {
        try {
            $jats = app(\App\Services\SourceImport\Content\JatsFullText::class);
            $xml = $jats->fetchXmlByDoi($doi);
            if (!$xml) {
                return ['status' => 'failed', 'reason' => 'No OA JATS full text'];
            }

            $article = $jats->toArticle($xml);
            if ($article['refCount'] === 0 && strlen(strip_tags($article['html'])) < 500) {
                return ['status' => 'failed', 'reason' => 'JATS parsed but body/refs empty'];
            }

            // toArticle already emits app-native HTML: in-text-citation anchors
            // (exact), bib-entry reference paragraphs, footnote markers. Persist
            // via the generic path — no process_document, no fuzzy linking.
            $result = $this->persistArticle(
                $article['html'],
                $article['references'],          // [{referenceId, content}]
                $article['footnotes'] ?? [],     // [{footnoteId, content}]
                $bookId,
                'jats_fulltext',
            );
            if ($result['status'] === 'failed') {
                $this->setPdfUrlStatus($bookId, $result['reason']);
                return $result;
            }

            Log::info('JATS full text imported', [
                'book' => $bookId, 'doi' => $doi,
                'nodes' => $result['node_count'], 'refs' => $article['refCount'],
                'footnotes' => count($article['footnotes'] ?? []),
            ]);

            $result['reason'] = "JATS full text imported ({$result['node_count']} nodes, {$article['refCount']} references)";
            return $result;
        } catch (\Throwable $e) {
            Log::warning('JATS full-text import failed (continuing to other strategies)', [
                'book' => $bookId, 'doi' => $doi, 'error' => $e->getMessage(),
            ]);
            return ['status' => 'failed', 'reason' => 'JATS import error: ' . Str::limit($e->getMessage(), 120)];
        }
    }

    /**
     * Headless-browser PDF fetch via scripts/fetch-pdf.mjs (Node + Playwright)
     * — shared with SourceImport\Content\PlaywrightPdfFetcher. Mirrors
     * downloadPdf's success contract: original.pdf on disk +
     * pdf_url_status='downloaded'.
     */
    /**
     * Fetch a rendered article HTML page via scripts/fetch-html.mjs (Playwright,
     * Cloudflare-aware). Returns the HTML string, or null on any failure (caller
     * falls through). Acquisition only — conversion happens in the paste engine.
     */
    private function fetchHtmlViaBrowser(string $url): ?string
    {
        try {
            $proc = new \Symfony\Component\Process\Process(['node', base_path('scripts/fetch-html.mjs')], base_path());
            $proc->setInput(json_encode(['url' => $url]));
            $proc->setTimeout(30);
            $proc->run();
        } catch (\Throwable $e) {
            Log::warning('Browser HTML fetch unavailable', ['url' => $url, 'error' => $e->getMessage()]);
            return null;
        }

        $r = json_decode(trim($proc->getOutput()), true);
        if (is_array($r) && ($r['ok'] ?? false) === true && !empty($r['html'])) {
            return $r['html'];
        }
        Log::info('Browser HTML fetch did not yield a page', [
            'url' => $url, 'reason' => is_array($r) ? ($r['reason'] ?? 'unknown') : 'no output',
        ]);
        return null;
    }

    private function fetchPdfViaBrowser(string $url, string $landing, string $bookId): array
    {
        $path = resource_path("markdown/{$bookId}");
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }
        $dest = "{$path}/original.pdf";

        try {
            $process = new \Symfony\Component\Process\Process(['node', base_path('scripts/fetch-pdf.mjs')], base_path());
            $process->setInput(json_encode(['url' => $url, 'dest' => $dest, 'landing' => $landing]));
            $process->setTimeout(25); // script's own hard timeout ~20s + headroom
            $process->run();
        } catch (\Throwable $e) {
            // Don't setPdfUrlStatus here — fetch()'s exhaustion path records it
            return ['status' => 'failed', 'reason' => 'Browser fetch unavailable: ' . Str::limit($e->getMessage(), 120)];
        }

        $result = json_decode(trim($process->getOutput()), true);

        $magicOk = File::exists($dest)
            && @file_get_contents($dest, false, null, 0, 5) === '%PDF-';

        if (is_array($result) && ($result['ok'] ?? false) === true && $magicOk) {
            @chmod($dest, 0644);
            $this->setPdfUrlStatus($bookId, 'downloaded');
            $size = number_format(File::size($dest));
            return [
                'status' => 'downloaded',
                'reason' => "PDF saved via headless browser ({$size} bytes) — ready for OCR",
            ];
        }

        $detail = is_array($result) ? ($result['reason'] ?? 'unknown') : 'no parseable output';
        return ['status' => 'failed', 'reason' => "Browser fetch failed: {$detail}"];
    }

    /**
     * PDF links the publisher deposited with Crossref (TDM / syndication).
     * Returns possibly-empty list of candidate URLs.
     */
    private function crossrefPdfLinks(string $doi): array
    {
        try {
            $resp = Http::timeout(15)->get('https://api.crossref.org/works/' . rawurlencode($doi));
            if (!$resp->successful()) {
                return [];
            }

            $urls = [];
            foreach ($resp->json('message.link') ?? [] as $link) {
                $url = $link['URL'] ?? null;
                if (!$url) {
                    continue;
                }
                $isPdf = ($link['content-type'] ?? '') === 'application/pdf'
                    || str_ends_with(strtolower(parse_url($url, PHP_URL_PATH) ?? ''), '.pdf');
                if ($isPdf) {
                    $urls[] = $url;
                }
            }

            return array_values(array_unique($urls));
        } catch (\Throwable $e) {
            Log::warning('Crossref link lookup failed', ['doi' => $doi, 'error' => $e->getMessage()]);
            return [];
        }
    }

    /**
     * Download a PDF and save to disk (no OCR). Sets pdf_url_status accordingly.
     * Uses browser-like headers and DOI-first referer to avoid publisher blocks.
     */
    private function downloadPdf(string $pdfUrl, string $bookId, ?string $doi = null): array
    {
        $path = resource_path("markdown/{$bookId}");

        try {
            // Step 1: If we have a DOI, resolve it first to get the landing page URL.
            // This gives us a legitimate Referer and warms any session/cookie requirements.
            $referer = null;
            if ($doi) {
                $doiUrl = 'https://doi.org/' . $doi;
                $doiResponse = Http::withHeaders(self::browserHeaders())
                    ->withOptions(['allow_redirects' => ['max' => 5, 'track_redirects' => true]])
                    ->timeout(15)
                    ->get($doiUrl);

                if ($doiResponse->successful()) {
                    // Use the final redirected URL as referer (the article landing page)
                    $redirectHistory = $doiResponse->header('X-Guzzle-Redirect-History');
                    $referer = $redirectHistory ? last(explode(', ', $redirectHistory)) : $doiUrl;
                }
            }

            // Step 2: Download the PDF with browser-like headers
            $headers = self::browserHeaders();
            $headers['Accept'] = 'application/pdf, */*';
            if ($referer) {
                $headers['Referer'] = $referer;
            }

            $response = Http::withHeaders($headers)->timeout(60)->get($pdfUrl);

            if (!$response->successful()) {
                $reason = "HTTP {$response->status()} fetching {$pdfUrl}";
                $this->setPdfUrlStatus($bookId, $reason);
                return ['status' => 'failed', 'reason' => $reason];
            }

            // Step 3: Content-Type check — reject HTML/text responses early
            $contentType = $response->header('Content-Type') ?? '';
            if ($contentType && !str_contains($contentType, 'pdf') && !str_contains($contentType, 'octet-stream')) {
                $reason = "Not a PDF response (Content-Type: {$contentType})";
                $this->setPdfUrlStatus($bookId, $reason);
                return ['status' => 'failed', 'reason' => $reason];
            }

            $body = $response->body();
            if (strlen($body) < 1000) {
                $reason = 'Fetched PDF too small (' . strlen($body) . ' bytes)';
                $this->setPdfUrlStatus($bookId, $reason);
                return ['status' => 'failed', 'reason' => $reason];
            }

            // Step 4: Magic bytes check
            if (substr($body, 0, 5) !== '%PDF-') {
                $reason = 'Not a PDF (bad magic bytes)';
                $this->setPdfUrlStatus($bookId, $reason);
                return ['status' => 'failed', 'reason' => $reason];
            }

            if (!File::exists($path)) {
                File::makeDirectory($path, 0755, true);
            }

            $pdfPath = "{$path}/original.pdf";
            File::put($pdfPath, $body);

            $this->setPdfUrlStatus($bookId, 'downloaded');

            $sizeFormatted = number_format(strlen($body));
            return [
                'status' => 'downloaded',
                'reason' => "PDF saved ({$sizeFormatted} bytes) — ready for OCR",
            ];

        } catch (\Exception $e) {
            Log::error('ContentFetchService::downloadPdf failed', [
                'book' => $bookId,
                'url' => $pdfUrl,
                'error' => $e->getMessage(),
            ]);

            $this->setPdfUrlStatus($bookId, Str::limit($e->getMessage(), 200));

            return [
                'status' => 'failed',
                'reason' => Str::limit($e->getMessage(), 200),
            ];
        }
    }

    /**
     * Browser-like HTTP headers to avoid publisher bot-detection.
     */
    public static function browserHeaders(): array
    {
        return [
            'User-Agent'      => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept'          => 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language'  => 'en-US,en;q=0.9',
            'Accept-Encoding' => 'gzip, deflate',
            'Connection'      => 'keep-alive',
            'Sec-Fetch-Dest'  => 'document',
            'Sec-Fetch-Mode'  => 'navigate',
            'Sec-Fetch-Site'  => 'cross-site',
        ];
    }

    /**
     * Assess HTML content quality before importing.
     *
     * Layer 1: Extract scholarly meta tags (citation_pdf_url, citation_abstract).
     * Layer 2: LLM content assessment when body quality is uncertain.
     *
     * @return array{action: string, reason: string, html?: string, abstract?: string}
     *   action: 'pdf_downloaded' | 'import_html' | 'no_content' | 'blocked' | 'abstract_only'
     */
    private function assessHtmlContent(string $html, string $bookId): array
    {
        // --- Layer 1: Meta-tag extraction (no LLM) ---
        $metaTags = $this->extractScholarlyMetaTags($html);

        // Try PDF download via citation_pdf_url
        if (!empty($metaTags['citation_pdf_url'])) {
            $doi = DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookId)->value('doi');

            $pdfResult = $this->downloadPdf($metaTags['citation_pdf_url'], $bookId, $doi);
            if ($pdfResult['status'] !== 'failed') {
                // Save abstract too if we found one
                if (!empty($metaTags['citation_abstract'])) {
                    $this->saveAbstractIfEmpty($bookId, $metaTags['citation_abstract']);
                }
                return ['action' => 'pdf_downloaded', 'reason' => $pdfResult['reason']];
            }
            // PDF download failed — continue to body assessment
            $this->setPdfUrlStatus($bookId, null); // reset so it doesn't block
        }

        // Save abstract from meta tags if available
        if (!empty($metaTags['citation_abstract'])) {
            $this->saveAbstractIfEmpty($bookId, $metaTags['citation_abstract']);
        }

        // --- Layer 2: LLM content assessment ---
        $cleanedHtml = $this->truncateHtmlForAssessment($html);

        $assessment = $this->llmService->assessHtmlContent($cleanedHtml);

        if (!$assessment) {
            // LLM failed — fall through to import and let quality gate catch it
            return ['action' => 'import_html', 'reason' => 'LLM assessment unavailable, importing as-is'];
        }

        if ($assessment['is_blocked']) {
            return ['action' => 'blocked', 'reason' => 'Page is blocked (captcha/login wall)'];
        }

        // Save LLM-extracted abstract if meta tags didn't have one
        if (!empty($assessment['abstract'])) {
            $this->saveAbstractIfEmpty($bookId, $assessment['abstract']);
        }

        if ($assessment['has_article_content']) {
            // Try to extract just the content div(s) if selector was identified
            $trimmedHtml = $html;
            if ($assessment['content_selector']) {
                $extracted = $this->extractContentBySelector($html, $assessment['content_selector']);
                if ($extracted) {
                    $trimmedHtml = $extracted;
                }
            }
            return ['action' => 'import_html', 'reason' => 'Article content found', 'html' => $trimmedHtml];
        }

        // No article content
        if (!empty($metaTags['citation_abstract']) || !empty($assessment['abstract'])) {
            return ['action' => 'abstract_only', 'reason' => 'No article body — abstract saved'];
        }

        return ['action' => 'no_content', 'reason' => 'No usable content found'];
    }

    /**
     * Extract scholarly meta tags from HTML <head>.
     */
    private function extractScholarlyMetaTags(string $html): array
    {
        $tags = [];
        $metaNames = ['citation_pdf_url', 'citation_abstract', 'citation_title', 'citation_doi'];

        foreach ($metaNames as $name) {
            // Match <meta name="citation_xxx" content="...">
            if (preg_match('/<meta\s+[^>]*name=["\']' . preg_quote($name, '/') . '["\']\s+[^>]*content=["\']([^"\']*)["\'][^>]*>/is', $html, $m)) {
                $tags[$name] = html_entity_decode(trim($m[1]), ENT_QUOTES, 'UTF-8');
            } elseif (preg_match('/<meta\s+[^>]*content=["\']([^"\']*)["\'][^>]*name=["\']' . preg_quote($name, '/') . '["\']\s*[^>]*>/is', $html, $m)) {
                // content before name order
                $tags[$name] = html_entity_decode(trim($m[1]), ENT_QUOTES, 'UTF-8');
            }
        }

        return $tags;
    }

    /**
     * Strip chrome from HTML and truncate for LLM assessment.
     */
    private function truncateHtmlForAssessment(string $html): string
    {
        // Remove script, style, nav, header, footer tags and their contents
        $patterns = [
            '/<script\b[^>]*>.*?<\/script>/is',
            '/<style\b[^>]*>.*?<\/style>/is',
            '/<nav\b[^>]*>.*?<\/nav>/is',
            '/<header\b[^>]*>.*?<\/header>/is',
            '/<footer\b[^>]*>.*?<\/footer>/is',
            '/<svg\b[^>]*>.*?<\/svg>/is',
            '/<noscript\b[^>]*>.*?<\/noscript>/is',
        ];

        $cleaned = preg_replace($patterns, '', $html);
        // Collapse whitespace
        $cleaned = preg_replace('/\s+/', ' ', $cleaned);

        // Truncate to ~4000 chars
        if (strlen($cleaned) > 4000) {
            $cleaned = substr($cleaned, 0, 4000) . "\n<!-- truncated -->";
        }

        return $cleaned;
    }

    /**
     * Try to extract content from HTML using a CSS-like selector description from the LLM.
     * Supports simple selectors: tag.class, tag[attr], tag#id.
     */
    private function extractContentBySelector(string $html, string $selector): ?string
    {
        // Convert LLM selector to a regex pattern for common cases
        // e.g. "div.article-body" → <div[^>]*class="[^"]*article-body[^"]*"
        // e.g. "section[data-article-body]" → <section[^>]*data-article-body
        $patterns = [];

        // Split on comma for multiple selectors
        $selectors = array_map('trim', explode(',', $selector));

        foreach ($selectors as $sel) {
            if (preg_match('/^(\w+)\.(.+)$/', $sel, $m)) {
                // tag.class
                $patterns[] = '/<' . preg_quote($m[1], '/') . '\b[^>]*class=["\'][^"\']*' . preg_quote($m[2], '/') . '[^"\']*["\'][^>]*>(.*?)<\/' . preg_quote($m[1], '/') . '>/is';
            } elseif (preg_match('/^(\w+)\[(.+)\]$/', $sel, $m)) {
                // tag[attr]
                $patterns[] = '/<' . preg_quote($m[1], '/') . '\b[^>]*' . preg_quote($m[2], '/') . '[^>]*>(.*?)<\/' . preg_quote($m[1], '/') . '>/is';
            } elseif (preg_match('/^(\w+)#(.+)$/', $sel, $m)) {
                // tag#id
                $patterns[] = '/<' . preg_quote($m[1], '/') . '\b[^>]*id=["\']' . preg_quote($m[2], '/') . '["\'][^>]*>(.*?)<\/' . preg_quote($m[1], '/') . '>/is';
            }
        }

        $extracted = '';
        foreach ($patterns as $pattern) {
            if (preg_match($pattern, $html, $m)) {
                $extracted .= $m[0] . "\n";
            }
        }

        return $extracted ?: null;
    }

    /**
     * Save abstract to library record if not already populated.
     */
    private function saveAbstractIfEmpty(string $bookId, string $abstract): void
    {
        if (strlen($abstract) < 50) {
            return; // Too short to be meaningful
        }

        // Validate with LLM before saving — reject paywall messages, metadata, etc.
        $title = DB::connection('pgsql_admin')->table('library')
            ->where('book', $bookId)->value('title');

        if ($title && !$this->llmService->validateAbstract($abstract, $title)) {
            Log::info('Rejected invalid abstract', ['book' => $bookId]);
            return;
        }

        try {
            DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookId)
                ->where(function ($q) {
                    $q->whereNull('abstract')->orWhere('abstract', '');
                })
                ->update(['abstract' => $abstract, 'updated_at' => now()]);
        } catch (\Exception $e) {
            Log::warning('Failed to save abstract', ['book' => $bookId, 'error' => $e->getMessage()]);
        }
    }

    /**
     * Count paragraphs in nodes.json with >100 chars of plainText.
     */
    private function countSubstantialParagraphs(string $nodesPath): int
    {
        if (!File::exists($nodesPath)) {
            return 0;
        }

        $nodes = json_decode(File::get($nodesPath), true);
        if (!is_array($nodes)) {
            return 0;
        }

        $count = 0;
        foreach ($nodes as $node) {
            $plainText = $node['plainText'] ?? '';
            if (strlen($plainText) > 100) {
                $count++;
            }
        }

        return $count;
    }

    private function fetchHtml(string $url, string $bookId): array
    {
        $path = resource_path("markdown/{$bookId}");

        try {
            // 1. Fetch HTML (browser headers to avoid publisher 403s)
            $response = Http::withHeaders(self::browserHeaders())
                ->timeout(30)->get($url);

            if (!$response->successful()) {
                return [
                    'status' => 'failed',
                    'reason' => "HTTP {$response->status()} fetching {$url}",
                ];
            }

            // 1b. If the server returned a PDF despite us requesting HTML, save it as a PDF
            $contentType = $response->header('Content-Type') ?? '';
            if (str_contains($contentType, 'application/pdf') || str_contains($contentType, 'octet-stream')) {
                $pdfResult = $this->savePdfResponse($response->body(), $bookId);
                if ($pdfResult) {
                    return $pdfResult;
                }
                return [
                    'status' => 'failed',
                    'reason' => "Server returned PDF Content-Type but body failed validation",
                ];
            }

            $html = $response->body();
            if (strlen($html) < 100) {
                return [
                    'status' => 'failed',
                    'reason' => 'Fetched HTML too short (' . strlen($html) . ' bytes)',
                ];
            }

            // 2. Save HTML to resources/markdown/{bookId}/original.html
            if (!File::exists($path)) {
                File::makeDirectory($path, 0755, true);
            }

            $htmlPath = "{$path}/original.html";
            File::put($htmlPath, $html);

            // 3. Assess content quality before processing
            $assessment = $this->assessHtmlContent($html, $bookId);

            if ($assessment['action'] === 'pdf_downloaded') {
                return ['status' => 'downloaded', 'reason' => $assessment['reason']];
            }

            if ($assessment['action'] === 'blocked') {
                $this->setPdfUrlStatus($bookId, $assessment['reason']);
                return ['status' => 'failed', 'reason' => $assessment['reason']];
            }

            if ($assessment['action'] === 'no_content') {
                $this->setPdfUrlStatus($bookId, 'no_content');
                return ['status' => 'failed', 'reason' => $assessment['reason']];
            }

            if ($assessment['action'] === 'abstract_only') {
                $this->setPdfUrlStatus($bookId, 'abstract_only');
                return ['status' => 'failed', 'reason' => $assessment['reason']];
            }

            // HTML import disabled — only PDFs are imported as content
            $this->setPdfUrlStatus($bookId, 'html_skipped');
            return ['status' => 'failed', 'reason' => 'HTML import disabled — only PDFs are imported as content'];

        } catch (\Exception $e) {
            Log::error('ContentFetchService::fetchHtml failed', [
                'book' => $bookId,
                'url' => $url,
                'error' => $e->getMessage(),
            ]);

            return [
                'status' => 'failed',
                'reason' => $e->getMessage(),
            ];
        }
    }

    /**
     * Download a PDF and run it through the OCR → markdown → nodes pipeline.
     * Called explicitly by citation:ocr command (not by fetch()).
     *
     * @return array{status: string, reason: string, node_count?: int}
     */
    public function fetchPdf(string $pdfUrl, string $bookId): array
    {
        $path = resource_path("markdown/{$bookId}");

        try {
            // 1. Download PDF
            $response = Http::withHeaders(self::browserHeaders())
                ->timeout(60)->get($pdfUrl);

            if (!$response->successful()) {
                $reason = "HTTP {$response->status()} fetching {$pdfUrl}";
                $this->setPdfUrlStatus($bookId, $reason);
                return ['status' => 'failed', 'reason' => $reason];
            }

            $body = $response->body();
            if (strlen($body) < 1000) {
                $reason = 'Fetched PDF too small (' . strlen($body) . ' bytes)';
                $this->setPdfUrlStatus($bookId, $reason);
                return ['status' => 'failed', 'reason' => $reason];
            }

            // 2. Save PDF to resources/markdown/{bookId}/original.pdf
            if (!File::exists($path)) {
                File::makeDirectory($path, 0755, true);
            }

            $pdfPath = "{$path}/original.pdf";
            File::put($pdfPath, $body);

            // 3. Process the local file
            return $this->processLocalPdf($pdfPath, $bookId);

        } catch (\Exception $e) {
            Log::error('ContentFetchService::fetchPdf failed', [
                'book' => $bookId,
                'url' => $pdfUrl,
                'error' => $e->getMessage(),
            ]);

            $this->setPdfUrlStatus($bookId, $e->getMessage());

            return [
                'status' => 'failed',
                'reason' => $e->getMessage(),
            ];
        }
    }

    /**
     * Process an already-downloaded PDF through the OCR → markdown → nodes pipeline.
     * The PDF must already exist on disk at $pdfPath.
     *
     * @return array{status: string, reason: string, node_count?: int}
     */
    public function processLocalPdf(string $pdfPath, string $bookId): array
    {
        $path = dirname($pdfPath);

        try {
            // 1. Clean stale output files
            foreach (['nodes.json', 'nodes.jsonl', 'footnotes.json', 'footnotes.jsonl', 'audit.json', 'references.json', 'intermediate.html', 'main-text.md', 'notify_email.json'] as $staleFile) {
                $staleFilePath = "{$path}/{$staleFile}";
                if (File::exists($staleFilePath)) {
                    File::delete($staleFilePath);
                }
            }

            // 2. Process via PdfProcessor (OCR → markdown → nodes.jsonl)
            $this->pdfProcessor->process($pdfPath, $path, $bookId);

            // 3. Wait for nodes.jsonl — the pipeline's streamed output format.
            // (nodes.json is a renumbered artifact WE produce during the DB
            // save below; waiting on it here deadlocked every OCR run after
            // the pipeline moved to jsonl.)
            $nodesPath = "{$path}/nodes.jsonl";
            $attempts = 0;
            while (!File::exists($nodesPath) && $attempts < 30) {
                sleep(2);
                $attempts++;
            }

            if (!File::exists($nodesPath)) {
                $reason = 'Timed out waiting for nodes.jsonl after PdfProcessor';
                $this->setPdfUrlStatus($bookId, $reason);
                return ['status' => 'failed', 'reason' => $reason];
            }

            // 4. Save nodes to DB
            $this->saveNodesToDatabase($path, $bookId);

            // 5. Save footnotes to DB
            $this->saveFootnotesToDatabase($path, $bookId);

            // 6. Update library record (don't touch creator — it's an auth field).
            // conversion_method: this path always produces machine-OCR'd content,
            // which is what makes the row eligible as a canonical auto-version.
            DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookId)
                ->update([
                    'has_nodes'         => true,
                    'listed'            => false,
                    'pdf_url_status'    => 'imported',
                    'conversion_method' => \App\Services\CanonicalVersions\AutoVersionResolver::CONVERSION_METHOD,
                    'updated_at'        => now(),
                ]);

            // 7. If this row is a version of a canonical work, let every version
            // authority re-evaluate its pointer (today: auto_version_book gets
            // wired once content exists). Never fails the import.
            $this->syncCanonicalVersionPointers($bookId);

            // Count nodes for reporting (one JSON object per jsonl line)
            $nodeCount = count(array_filter(array_map('trim',
                file($nodesPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: []
            )));

            return [
                'status' => 'imported',
                'reason' => 'PDF OCR processed and imported successfully',
                'node_count' => $nodeCount,
            ];

        } catch (\Exception $e) {
            Log::error('ContentFetchService::processLocalPdf failed', [
                'book' => $bookId,
                'path' => $pdfPath,
                'error' => $e->getMessage(),
            ]);

            // Truncate for storage and display — full error is in the log
            $shortReason = Str::limit($e->getMessage(), 200);
            $this->setPdfUrlStatus($bookId, $shortReason);

            return [
                'status' => 'failed',
                'reason' => $shortReason,
            ];
        }
    }

    /**
     * THE KEYSTONE — convert journal HTML to app-native dynamic citations via
     * the shared paste engine (scripts/paste-convert.mjs = the same processors
     * the front-end paste path uses), gate it, and persist nodes + bibliography
     * + footnotes. Acquisition (Playwright/fetch) hands us the HTML; this turns
     * it into the app's interactive format.
     *
     * @param string $html   rendered journal-article HTML
     * @param string $bookId library stub id
     * @param string $url    source URL (for logging)
     */
    private function importViaPasteEngine(string $html, string $bookId, string $url): array
    {
        // 1. Convert via the shared engine (Node + happy-dom).
        try {
            $proc = new \Symfony\Component\Process\Process(['node', base_path('scripts/paste-convert.mjs')], base_path());
            $proc->setInput(json_encode(['html' => $html]));
            $proc->setTimeout(60);
            $proc->run();
        } catch (\Throwable $e) {
            return ['status' => 'failed', 'reason' => 'paste engine unavailable: ' . Str::limit($e->getMessage(), 120)];
        }

        $engine = json_decode(trim($proc->getOutput()), true);
        if (!is_array($engine) || ($engine['ok'] ?? false) !== true) {
            $detail = is_array($engine) ? ($engine['reason'] ?? 'unknown') : 'no parseable output';
            return ['status' => 'failed', 'reason' => "paste engine failed: {$detail}"];
        }

        // 2. Authenticity gate — is this actually THE article? (requirement 3)
        $verdict = $this->assessArticleAuthenticity($html, $engine, $bookId);
        if ($verdict === 'reject') {
            $reason = 'Page identity does not match the cited source — not imported';
            $this->setPdfUrlStatus($bookId, $reason);
            return ['status' => 'failed', 'reason' => $reason];
        }

        // 3. Persist. verified → paste_engine_html (canonical-eligible);
        // unverified → html_scrape_unverified, NOT in SYSTEM_CONVERSION_METHODS,
        // so it can never become a canonical version (requirement 3).
        $conversionMethod = $verdict === 'verified' ? 'paste_engine_html' : 'html_scrape_unverified';
        $footnotes = array_values(array_filter(array_map(function ($f) {
            $id = $f['footnoteId'] ?? $f['refId'] ?? null;
            return ($id && !empty($f['content'])) ? ['footnoteId' => $id, 'content' => $f['content']] : null;
        }, $engine['footnotes'] ?? [])));

        $result = $this->persistArticle($engine['html'] ?? '', $engine['references'] ?? [], $footnotes, $bookId, $conversionMethod);
        if ($result['status'] === 'failed') {
            return $result;
        }

        Log::info('Paste-engine HTML import complete', [
            'book' => $bookId, 'url' => $url, 'format' => $engine['formatType'] ?? '?',
            'verdict' => $verdict, 'nodes' => $result['node_count'],
            'refs' => count($engine['references'] ?? []), 'footnotes' => count($footnotes),
        ]);

        $result['reason'] = "Journal HTML imported via paste engine ({$verdict}: {$result['node_count']} nodes, "
            . count($engine['references'] ?? []) . ' refs, ' . count($footnotes) . ' footnotes)';
        return $result;
    }

    /**
     * Acquire + verify + import a NON-ACADEMIC web source (news/gov/blog).
     * Browser-fetches the full page, then runs BOTH:
     *   - WebArticleVerifier (identity: does the page declare itself the cited
     *     article? — JSON-LD/OpenGraph headline vs the citation title), and
     *   - the paste engine (body + footnotes/citations, e.g. Substack footnotes).
     *
     * Persists via persistArticle with conversion_method carrying the verdict:
     *   web_article_verified   — page IS the cited article (URL-content match)
     *   web_article_unverified — got the page but couldn't confirm identity
     * Neither is in AutoVersionResolver::SYSTEM_CONVERSION_METHODS — a web
     * source has no academic identity and can never become a canonical version.
     * A 'reject' verdict (page contradicts the citation) imports nothing.
     */
    public function importWebSource(string $url, string $citationTitle, string $bookId): array
    {
        $html = $this->fetchHtmlViaBrowser($url);
        if ($html === null) {
            return ['status' => 'failed', 'reason' => 'Could not fetch the web page'];
        }

        // Identity verdict (the honest URL-content match).
        $verdict = app(\App\Services\SourceImport\Content\WebArticleVerifier::class)
            ->assess($html, $citationTitle);
        if ($verdict['verdict'] === \App\Services\SourceImport\Content\WebArticleVerifier::REJECT) {
            $reason = "Page is not the cited article (page: \"" . Str::limit($verdict['page_title'] ?? '?', 80) . '")';
            $this->setPdfUrlStatus($bookId, $reason);
            // Mark it so the review can warn that the cited URL hosts a DIFFERENT
            // article — the scan-time HTTP scrape of the same URL is the wrong page.
            DB::connection('pgsql_admin')->table('library')->where('book', $bookId)
                ->update(['conversion_method' => 'web_article_rejected', 'updated_at' => now()]);
            return ['status' => 'failed', 'reason' => $reason, 'web_verdict' => $verdict];
        }

        // Convert body + footnotes via the shared paste engine.
        try {
            $proc = new \Symfony\Component\Process\Process(['node', base_path('scripts/paste-convert.mjs')], base_path());
            $proc->setInput(json_encode(['html' => $html]));
            $proc->setTimeout(60);
            $proc->run();
        } catch (\Throwable $e) {
            return ['status' => 'failed', 'reason' => 'paste engine unavailable: ' . Str::limit($e->getMessage(), 120)];
        }
        $engine = json_decode(trim($proc->getOutput()), true);
        if (!is_array($engine) || ($engine['ok'] ?? false) !== true) {
            return ['status' => 'failed', 'reason' => 'paste engine failed on web page'];
        }

        $footnotes = array_values(array_filter(array_map(function ($f) {
            $id = $f['footnoteId'] ?? $f['refId'] ?? null;
            return ($id && !empty($f['content'])) ? ['footnoteId' => $id, 'content' => $f['content']] : null;
        }, $engine['footnotes'] ?? [])));

        $conversionMethod = $verdict['verdict'] === \App\Services\SourceImport\Content\WebArticleVerifier::VERIFIED
            ? 'web_article_verified'
            : 'web_article_unverified';

        $result = $this->persistArticle($engine['html'] ?? '', $engine['references'] ?? [], $footnotes, $bookId, $conversionMethod);
        if ($result['status'] === 'failed') {
            return $result;
        }

        // On a confirmed URL-content match, group this source under a WEB
        // canonical keyed on the URL (version-grouping; NOT academic). Only on
        // 'verified' — never the unverified path. type='web', no academic signals.
        if ($verdict['verdict'] === \App\Services\SourceImport\Content\WebArticleVerifier::VERIFIED) {
            try {
                $library = \App\Models\PgLibrary::on('pgsql_admin')->where('book', $bookId)->first();
                if ($library) {
                    app(\App\Services\CanonicalSourceMatcher::class)->linkWebSourceToCanonical(
                        $library, $url, $verdict['page_title'] ?? $citationTitle,
                        $library->author, $library->year ? (int) $library->year : null,
                    );
                }
            } catch (\Throwable $e) {
                Log::warning('Web canonical link failed (import unaffected)', ['book' => $bookId, 'error' => $e->getMessage()]);
            }
        }

        Log::info('Web source imported + verified', [
            'book' => $bookId, 'url' => $url, 'verdict' => $verdict['verdict'],
            'matched_on' => $verdict['matched_on'], 'score' => $verdict['score'],
            'nodes' => $result['node_count'], 'footnotes' => count($footnotes),
        ]);

        $result['reason'] = "Web source imported ({$verdict['verdict']} via {$verdict['matched_on']}, "
            . "title match {$verdict['score']}: {$result['node_count']} nodes, " . count($footnotes) . ' footnotes)';
        $result['web_verdict'] = $verdict;
        return $result;
    }

    /**
     * Generic article-result persistence — shared by the paste-engine HTML path
     * and the JATS path. Takes app-native linked HTML + normalised references
     * ([{referenceId, content}]) + footnotes ([{footnoteId, content}]), splits
     * the HTML into nodes (NO process_document re-linking — the citations are
     * already linked), and writes nodes + bibliography + footnotes, then wires
     * canonical pointers. NOT paste-specific.
     */
    private function persistArticle(string $html, array $references, array $footnotes, string $bookId, string $conversionMethod): array
    {
        $path = resource_path("markdown/{$bookId}");
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }
        foreach (['nodes.json', 'nodes.jsonl', 'footnotes.json', 'footnotes.jsonl'] as $stale) {
            if (File::exists("{$path}/{$stale}")) File::delete("{$path}/{$stale}");
        }

        $nodeCount = $this->writeNodesJsonlFromHtml($html, $path);
        if ($nodeCount === 0) {
            return ['status' => 'failed', 'reason' => 'no content blocks produced'];
        }
        $this->saveNodesToDatabase($path, $bookId);

        if ($footnotes) {
            File::put("{$path}/footnotes.jsonl", implode("\n", array_map('json_encode', $footnotes)));
            $this->saveFootnotesToDatabase($path, $bookId);
        }

        $db = DB::connection('pgsql_admin');
        $now = now();
        foreach ($references as $ref) {
            $refId = $ref['referenceId'] ?? null;
            if (!$refId || empty($ref['content'])) continue;
            // Clamp to the column width — the general processor can generate a
            // degenerate token-concatenation id from junk reference text.
            $refId = mb_substr($refId, 0, 200);
            $db->table('bibliography')->updateOrInsert(
                ['book' => $bookId, 'referenceId' => $refId],
                ['content' => $ref['content'], 'updated_at' => $now, 'created_at' => $now],
            );
        }

        $db->table('library')->where('book', $bookId)->update([
            'has_nodes'         => true,
            'listed'            => false,
            'pdf_url_status'    => 'imported',
            'conversion_method' => $conversionMethod,
            'updated_at'        => $now,
        ]);
        $this->syncCanonicalVersionPointers($bookId);

        return ['status' => 'imported', 'reason' => 'imported', 'node_count' => $nodeCount];
    }

    /**
     * Is the fetched page actually the cited article?
     *   reject     — identity actively contradicts (DOI present and different,
     *                or title strongly dissimilar). Do not import.
     *   verified   — identity confirmed AND a real publisher processor matched
     *                with references. Eligible to become a canonical version.
     *   unverified — got usable content but identity weak or completeness thin.
     *                Import, but never promote to canonical.
     */
    private function assessArticleAuthenticity(string $html, array $engine, string $bookId): string
    {
        $stub = DB::connection('pgsql_admin')->table('library')
            ->where('book', $bookId)->select('title', 'doi')->first();
        $meta = $this->extractScholarlyMetaTags($html);

        // Identity
        $identity = 'unknown';
        $pageDoi = $meta['citation_doi'] ?? null;
        if ($pageDoi && !empty($stub->doi)) {
            $norm = fn($d) => strtolower(trim(preg_replace('#^https?://doi.org/#i', '', $d)));
            $identity = $norm($pageDoi) === $norm($stub->doi) ? 'confirmed' : 'contradicted';
        }
        if ($identity === 'unknown' && !empty($meta['citation_title']) && !empty($stub->title)) {
            $sim = app(OpenAlexService::class)->titleSimilarity($stub->title, $meta['citation_title']);
            $identity = $sim >= 0.7 ? 'confirmed' : ($sim < 0.3 ? 'contradicted' : 'weak');
        }
        if ($identity === 'contradicted') {
            return 'reject';
        }

        // Completeness — a real publisher processor matched (not the general
        // fallback) and produced references.
        $formatType = $engine['formatType'] ?? 'general';
        $refCount = count($engine['references'] ?? []);
        $complete = $formatType !== 'general' && $refCount > 0;

        return ($identity === 'confirmed' && $complete) ? 'verified' : 'unverified';
    }

    /**
     * Split linked article HTML into block-level node rows (one JSON object per
     * line) for saveNodesToDatabase — mirrors how the front-end paste path
     * stores each block as a node, WITHOUT routing through process_document
     * (the engine already linked citations/footnotes; re-linking would clobber).
     */
    private function writeNodesJsonlFromHtml(string $html, string $path): int
    {
        if (trim($html) === '') return 0;

        $doc = new \DOMDocument();
        $prev = libxml_use_internal_errors(true);
        $doc->loadHTML('<?xml encoding="UTF-8"><div id="__root">' . $html . '</div>', LIBXML_NOERROR | LIBXML_NOWARNING);
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        $root = $doc->getElementById('__root');
        if (!$root) return 0;

        $lines = [];
        foreach ($root->childNodes as $child) {
            if ($child->nodeType !== XML_ELEMENT_NODE) continue;
            $content = $doc->saveHTML($child);
            $plain = trim($child->textContent);
            if ($plain === '' && stripos($content, '<img') === false) continue;
            $lines[] = json_encode([
                'content'   => $content,
                'plainText' => $plain,
                'type'      => strtolower($child->nodeName),
            ]);
        }

        if (!$lines) return 0;
        File::put("{$path}/nodes.jsonl", implode("\n", $lines));
        return count($lines);
    }

    /**
     * Detect URLs that point to PDFs based on path patterns.
     */
    private function looksLikePdf(string $url): bool
    {
        $path = strtolower(parse_url($url, PHP_URL_PATH) ?? '');

        return str_ends_with($path, '.pdf')
            || str_contains($path, '/pdf/')
            || str_contains($path, '/downloadpdf/')
            || str_contains($path, 'article-pdf')
            || str_contains($path, 'viewcontent.cgi');
    }

    /**
     * Validate and save a PDF response body to disk.
     *
     * @return array{status: string, reason: string}|null  Result on success, null on validation failure.
     */
    private function savePdfResponse(string $body, string $bookId): ?array
    {
        if (strlen($body) < 1000) {
            return null;
        }

        if (substr($body, 0, 5) !== '%PDF-') {
            return null;
        }

        $path = resource_path("markdown/{$bookId}");
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        File::put("{$path}/original.pdf", $body);
        $this->setPdfUrlStatus($bookId, 'downloaded');

        $sizeFormatted = number_format(strlen($body));
        return [
            'status' => 'downloaded',
            'reason' => "PDF saved ({$sizeFormatted} bytes) — ready for OCR",
        ];
    }

    /**
     * Record the outcome of a pdf_url fetch attempt on the library record.
     */
    private function setPdfUrlStatus(string $bookId, ?string $status): void
    {
        try {
            DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookId)
                ->update(['pdf_url_status' => $status, 'updated_at' => now()]);
        } catch (\Exception $e) {
            Log::warning('Failed to set pdf_url_status', ['book' => $bookId, 'error' => $e->getMessage()]);
        }
    }

    /**
     * After content lands on a canonical-linked library row, run every version
     * authority over the canonical (VersionPointerRegistry::syncAll). This is
     * the hook that turns "the pipeline vacuumed+OCR'd a citation's PDF" into
     * "the canonical now has a genuine auto version". Best-effort by design.
     */
    private function syncCanonicalVersionPointers(string $bookId): void
    {
        try {
            $canonicalId = DB::connection('pgsql_admin')
                ->table('library')
                ->where('book', $bookId)
                ->value('canonical_source_id');

            if (!$canonicalId) {
                return;
            }

            $canonical = \App\Models\CanonicalSource::find($canonicalId);
            if (!$canonical) {
                return;
            }

            $assigned = \App\Services\CanonicalVersions\VersionPointerRegistry::syncAll($canonical);
            if (!empty($assigned)) {
                Log::info('Canonical version pointers synced after OCR', [
                    'book'      => $bookId,
                    'canonical' => $canonicalId,
                    'assigned'  => $assigned,
                ]);
            }
        } catch (\Throwable $e) {
            Log::warning('Canonical pointer sync failed (import unaffected)', [
                'book'  => $bookId,
                'error' => $e->getMessage(),
            ]);
        }
    }

    /**
     * Save node chunks from the pipeline's nodes.jsonl to database.
     * Replicates ProcessDocumentImportJob::saveNodesToDatabase logic,
     * including writing the renumbered nodes.json artifact (what the editor
     * saver reads) as a by-product.
     */
    private function saveNodesToDatabase(string $path, string $bookId): void
    {
        $nodesPath = "{$path}/nodes.jsonl";
        if (!File::exists($nodesPath)) {
            Log::warning('nodes.jsonl not found for database save', ['book' => $bookId]);
            return;
        }

        $nodesData = [];
        foreach (file($nodesPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $decoded = json_decode(trim($line), true);
            if ($decoded !== null) {
                $nodesData[] = $decoded;
            }
        }

        $db = DB::connection('pgsql_admin');

        // Delete existing chunks
        $db->table('nodes')->where('book', $bookId)->delete();

        $insertData = [];
        $now = now();
        $nodesPerChunk = 100;

        foreach ($nodesData as $index => $chunk) {
            $newStartLine = ($index + 1) * 100;
            $chunkIndex = floor($index / $nodesPerChunk);
            $newChunkId = $chunkIndex * 100;
            $nodeId = $this->fileHelpers->generateNodeId($bookId);
            $content = $this->fileHelpers->ensureNodeIdInContent($chunk['content'], $newStartLine, $nodeId);

            $rawJson = $chunk;
            $rawJson['startLine'] = $newStartLine;
            $rawJson['chunk_id'] = $newChunkId;
            $rawJson['node_id'] = $nodeId;
            $rawJson['content'] = $content;

            $insertData[] = [
                'book' => $bookId,
                'startLine' => $newStartLine,
                'chunk_id' => $newChunkId,
                'node_id' => $nodeId,
                'content' => $content,
                'footnotes' => json_encode($chunk['footnotes'] ?? []),
                'plainText' => $chunk['plainText'] ?? '',
                'type' => $chunk['type'] ?? 'p',
                'raw_json' => json_encode($rawJson),
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        $batchSize = 500;
        foreach (array_chunk($insertData, $batchSize) as $batch) {
            $db->table('nodes')->insert($batch);
        }

        // Write the renumbered nodes.json artifact (kept alongside nodes.jsonl —
        // the editor saver reads nodes.json)
        $renumberedJson = array_map(fn($r) => json_decode($r['raw_json'], true), $insertData);
        File::put("{$path}/nodes.json", json_encode($renumberedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        Log::info('ContentFetchService saved nodes to database', [
            'book' => $bookId,
            'count' => count($insertData),
        ]);
    }

    /**
     * Save footnotes from JSON file to database.
     * Replicates ImportController::saveFootnotesToDatabase logic.
     */
    private function saveFootnotesToDatabase(string $path, string $bookId): void
    {
        // Pipeline emits footnotes.jsonl; accept legacy footnotes.json too.
        $footnotesData = [];
        $jsonlPath = "{$path}/footnotes.jsonl";
        $jsonPath  = "{$path}/footnotes.json";

        if (File::exists($jsonlPath)) {
            foreach (file($jsonlPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
                $decoded = json_decode(trim($line), true);
                if ($decoded !== null) {
                    $footnotesData[] = $decoded;
                }
            }
        } elseif (File::exists($jsonPath)) {
            $footnotesData = json_decode(File::get($jsonPath), true) ?: [];
        }

        if (empty($footnotesData)) {
            return;
        }

        $db = DB::connection('pgsql_admin');

        $library = $db->table('library')->where('book', $bookId)->first();
        if (!$library) {
            Log::warning('Cannot save footnotes: parent library not found', ['book' => $bookId]);
            return;
        }

        $upsertedCount = 0;
        $enrichedForJson = [];

        foreach ($footnotesData as $footnote) {
            $footnoteId = $footnote['footnoteId'] ?? null;
            $content    = $footnote['content'] ?? '';
            if (!$footnoteId) continue;

            $subBookId = SubBookIdHelper::build($bookId, $footnoteId);
            $uuid      = (string) Str::uuid();
            $plainText = strip_tags($content);
            $nodeHtml  = '<p data-node-id="' . e($uuid) . '" no-delete-id="please" '
                       . 'style="min-height:1.5em;">' . e($plainText) . '</p>';

            $previewNodes = [[
                'book'        => $subBookId,
                'chunk_id'    => 0,
                'startLine'   => 1.0,
                'node_id'     => $uuid,
                'content'     => $nodeHtml,
                'footnotes'   => [],
                'hyperlights' => [],
                'hypercites'  => [],
            ]];

            $existing = $db->table('footnotes')
                ->where('book', $bookId)
                ->where('footnoteId', $footnoteId)
                ->first();

            if ($existing) {
                $db->table('footnotes')
                    ->where('book', $bookId)
                    ->where('footnoteId', $footnoteId)
                    ->update([
                        'content'       => $content,
                        'sub_book_id'   => $subBookId,
                        'preview_nodes' => json_encode($previewNodes),
                    ]);
            } else {
                $db->table('footnotes')->insert([
                    'book'          => $bookId,
                    'footnoteId'    => $footnoteId,
                    'content'       => $content,
                    'sub_book_id'   => $subBookId,
                    'preview_nodes' => json_encode($previewNodes),
                    'created_at'    => now(),
                    'updated_at'    => now(),
                ]);
            }

            $db->table('library')->updateOrInsert(
                ['book' => $subBookId],
                [
                    'creator'       => $library->creator,
                    'creator_token' => $library->creator_token,
                    'visibility'    => $library->visibility,
                    'listed'        => false,
                    'title'         => "Annotation: {$footnoteId}",
                    'type'          => 'sub_book',
                    'has_nodes'     => true,
                    'raw_json'      => json_encode([]),
                    'timestamp'     => round(microtime(true) * 1000),
                    'updated_at'    => now(),
                    'created_at'    => now(),
                ]
            );

            $db->table('nodes')->updateOrInsert(
                ['book' => $subBookId, 'node_id' => $uuid],
                [
                    'chunk_id'   => 0,
                    'startLine'  => 1,
                    'content'    => $nodeHtml,
                    'plainText'  => $plainText,
                    'raw_json'   => json_encode([]),
                    'created_at' => now(),
                    'updated_at' => now(),
                ]
            );

            $upsertedCount++;
            $enrichedForJson[] = [
                'footnoteId'    => $footnoteId,
                'content'       => $content,
                'preview_nodes' => $previewNodes,
            ];
        }

        // Enriched footnotes.json artifact (preview_nodes included), like the import path
        File::put($jsonPath, json_encode($enrichedForJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        Log::info("ContentFetchService saved {$upsertedCount} footnotes", ['book' => $bookId]);
    }
}
