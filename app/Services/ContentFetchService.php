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

        // Strategy 4: DOI resolution (last resort — even if oa_url existed but failed)
        if ($doi) {
            $doiUrl = 'https://doi.org/' . $doi;
            $result = $this->fetchHtml($doiUrl, $bookId);
            if ($result['status'] !== 'failed') {
                return $result;
            }
            $lastFailure = $result['reason'];
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
        $metaNames = ['citation_pdf_url', 'citation_abstract', 'citation_title'];

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

            // 2. Process via PdfProcessor (OCR → markdown → nodes.json)
            $this->pdfProcessor->process($pdfPath, $path, $bookId);

            // 3. Wait for nodes.json (OCR is slower, allow up to 60s)
            $nodesPath = "{$path}/nodes.json";
            $attempts = 0;
            while (!File::exists($nodesPath) && $attempts < 30) {
                sleep(2);
                $attempts++;
            }

            if (!File::exists($nodesPath)) {
                $reason = 'Timed out waiting for nodes.json after PdfProcessor';
                $this->setPdfUrlStatus($bookId, $reason);
                return ['status' => 'failed', 'reason' => $reason];
            }

            // 4. Save nodes to DB
            $this->saveNodeChunksToDatabase($path, $bookId);

            // 5. Save footnotes to DB
            $this->saveFootnotesToDatabase($path, $bookId);

            // 6. Update library record (don't touch creator — it's an auth field)
            DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookId)
                ->update([
                    'has_nodes'      => true,
                    'listed'         => false,
                    'pdf_url_status' => 'imported',
                    'updated_at'     => now(),
                ]);

            // Count nodes for reporting
            $nodesData = json_decode(File::get($nodesPath), true);
            $nodeCount = is_array($nodesData) ? count($nodesData) : 0;

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
     * Save node chunks from JSON file to database.
     * Replicates ImportController::saveNodeChunksToDatabase logic.
     */
    private function saveNodeChunksToDatabase(string $path, string $bookId): void
    {
        $nodesPath = "{$path}/nodes.json";
        if (!File::exists($nodesPath)) {
            Log::warning('nodes.json not found for database save', ['book' => $bookId]);
            return;
        }

        $nodesData = json_decode(File::get($nodesPath), true);

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

        // Write renumbered JSON back
        $renumberedJson = array_map(fn($r) => json_decode($r['raw_json'], true), $insertData);
        File::put($nodesPath, json_encode($renumberedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

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
        $footnotesPath = "{$path}/footnotes.json";
        if (!File::exists($footnotesPath)) {
            return;
        }

        $footnotesData = json_decode(File::get($footnotesPath), true);
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

        File::put($footnotesPath, json_encode($enrichedForJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        Log::info("ContentFetchService saved {$upsertedCount} footnotes", ['book' => $bookId]);
    }
}
