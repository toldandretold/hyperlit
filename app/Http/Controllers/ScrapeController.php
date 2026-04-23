<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class ScrapeController extends Controller
{
    private const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

    // ──────────────────────────────────────────────
    //  Shared helpers
    // ──────────────────────────────────────────────

    /**
     * Fetch a page with a browser User-Agent.
     */
    private function fetchPage(string $url): string
    {
        $response = Http::withHeaders([
            'User-Agent' => self::USER_AGENT,
        ])->timeout(30)->get($url);

        if (!$response->successful()) {
            throw new \RuntimeException("HTTP {$response->status()} fetching {$url}");
        }

        return $response->body();
    }

    /**
     * Validate that a URL belongs to an allowed host.
     */
    private function validateHost(string $url, array $allowed): ?JsonResponse
    {
        $host = parse_url($url, PHP_URL_HOST);
        if (!in_array($host, $allowed, true)) {
            return $this->error('Unsupported domain: ' . $host, 422);
        }
        return null;
    }

    // ──────────────────────────────────────────────
    //  Novel scraper  (mydramanovel.com)
    // ──────────────────────────────────────────────

    private const NOVEL_HOSTS = ['mydramanovel.com', 'www.mydramanovel.com'];

    /**
     * POST /api/scrape/novel/chapters
     * Fetch a chapter-list page and return {title, chapters: [{title, url}]}
     */
    public function novelChapters(Request $request): JsonResponse
    {
        $request->validate(['url' => 'required|url']);
        $url = $request->input('url');

        if ($err = $this->validateHost($url, self::NOVEL_HOSTS)) return $err;

        try {
            $html = $this->fetchPage($url);
            [$bookTitle, $chapters] = $this->parseNovelChapterList($html, $url);

            return response()->json([
                'title'    => $bookTitle,
                'chapters' => $chapters,
            ]);
        } catch (\Exception $e) {
            Log::error('Novel scraper chapters failed: ' . $e->getMessage());
            return $this->serverError('Failed to fetch chapter list: ' . $e->getMessage());
        }
    }

    /**
     * POST /api/scrape/novel/chapter
     * Fetch a single chapter page and return {title, paragraphs: []}
     */
    public function novelChapter(Request $request): JsonResponse
    {
        $request->validate(['url' => 'required|url']);
        $url = $request->input('url');

        if ($err = $this->validateHost($url, self::NOVEL_HOSTS)) return $err;

        try {
            $html = $this->fetchPage($url);
            [$chapterTitle, $paragraphs] = $this->parseNovelChapter($html);

            return response()->json([
                'title'      => $chapterTitle,
                'paragraphs' => $paragraphs,
            ]);
        } catch (\Exception $e) {
            Log::error('Novel scraper chapter failed: ' . $e->getMessage());
            return $this->serverError('Failed to fetch chapter: ' . $e->getMessage());
        }
    }

    /**
     * Parse a chapter-list page. Returns [bookTitle, [{title, url}, ...]].
     */
    private function parseNovelChapterList(string $html, string $sourceUrl): array
    {
        // Book title: <h1 ... class="...tdb-title-text..." ...>Title</h1>
        $bookTitle = 'Untitled';
        if (preg_match('/<h1[^>]*class="[^"]*tdb-title-text[^"]*"[^>]*>(.*?)<\/h1>/s', $html, $m)) {
            $bookTitle = trim(html_entity_decode(strip_tags($m[1]), ENT_QUOTES, 'UTF-8'));
        }

        // Chapter links: <h2|h3 class="entry-title td-module-title"><a href="...">Title</a>
        $pattern = '/<h[23][^>]*class="[^"]*entry-title[^"]*td-module-title[^"]*"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/s';
        preg_match_all($pattern, $html, $matches, PREG_SET_ORDER);

        // Determine book slug from source URL to filter out unrelated "related posts"
        $parsedUrl = parse_url($sourceUrl);
        $pathParts = array_values(array_filter(explode('/', trim($parsedUrl['path'] ?? '', '/'))));
        $bookSlug  = $pathParts[0] ?? '';

        $chapters = [];
        $seenUrls = [];

        foreach ($matches as $match) {
            $href  = $match[1];
            $title = trim(html_entity_decode(strip_tags($match[2]), ENT_QUOTES, 'UTF-8'));

            // Make URL absolute if needed
            if (!str_starts_with($href, 'http')) {
                $href = rtrim($sourceUrl, '/') . '/' . ltrim($href, '/');
            }

            // Filter: keep only links whose path starts with the same slug
            $linkParsed = parse_url($href);
            $linkParts  = array_values(array_filter(explode('/', trim($linkParsed['path'] ?? '', '/'))));
            if ($bookSlug && !empty($linkParts) && $linkParts[0] !== $bookSlug) {
                continue;
            }

            // Deduplicate
            if (in_array($href, $seenUrls, true)) {
                continue;
            }
            $seenUrls[] = $href;

            $chapters[] = ['title' => $title, 'url' => $href];
        }

        return [$bookTitle, $chapters];
    }

    /**
     * Parse a single chapter page. Returns [chapterTitle, [paragraphTexts]].
     */
    private function parseNovelChapter(string $html): array
    {
        // Chapter title
        $chapterTitle = 'Untitled Chapter';
        if (preg_match('/<h1[^>]*class="[^"]*tdb-title-text[^"]*"[^>]*>(.*?)<\/h1>/s', $html, $m)) {
            $chapterTitle = trim(html_entity_decode(strip_tags($m[1]), ENT_QUOTES, 'UTF-8'));
        }

        // Content: find <div class="...tdb_single_content...">
        $contentHtml = '';
        if (preg_match('/<div[^>]*class="[^"]*tdb_single_content[^"]*"[^>]*>(.*?)<\/div>\s*<\/div>\s*<\/div>/s', $html, $m)) {
            $contentHtml = $m[1];
        } elseif (preg_match('/<div[^>]*class="[^"]*tdb_single_content[^"]*"[^>]*>(.*)/s', $html, $m)) {
            $contentHtml = $m[1];
        }

        $paragraphs = [];
        if ($contentHtml) {
            preg_match_all('/<p[^>]*>(.*?)<\/p>/s', $contentHtml, $pMatches);
            foreach ($pMatches[1] as $pHtml) {
                $text = trim(html_entity_decode(strip_tags($pHtml), ENT_QUOTES, 'UTF-8'));
                if ($text !== '') {
                    $paragraphs[] = $text;
                }
            }
        }

        return [$chapterTitle, $paragraphs];
    }
}
