<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class BraveSearchService
{
    private WebFetchService $webFetch;

    /** Domains that consistently block automated fetches. */
    private const BLOCKED_DOMAINS = [
        'reuters.com',
        'bloomberg.com',
        'wsj.com',
        'ft.com',
        'nytimes.com',
    ];

    public function __construct(WebFetchService $webFetch)
    {
        $this->webFetch = $webFetch;
    }

    /**
     * Search Brave, fetch the top results, validate content, and create a web stub.
     * Returns the stub book ID or null if nothing useful was found.
     */
    public function searchAndFetch(
        string $title,
        ?string $author,
        ?int $year,
        $db
    ): ?string {
        $apiKey = config('services.brave_search.api_key');
        if (!$apiKey) {
            return null;
        }

        $query = $this->buildQuery($title, $author, $year);

        try {
            $response = Http::withHeaders([
                'Accept'               => 'application/json',
                'Accept-Encoding'      => 'gzip',
                'X-Subscription-Token' => $apiKey,
            ])->timeout(15)->get('https://api.search.brave.com/res/v1/web/search', [
                'q'     => $query,
                'count' => 5,
            ]);

            if (!$response->successful()) {
                Log::warning('Brave Search API returned ' . $response->status());
                return null;
            }

            $results = $response->json('web.results') ?? [];

            if (empty($results)) {
                return null;
            }

            // Try up to 3 results
            $tried = 0;
            foreach ($results as $result) {
                if ($tried >= 3) {
                    break;
                }

                $url = $result['url'] ?? null;
                if (!$url) {
                    continue;
                }

                // Skip PDFs
                $path = strtolower(parse_url($url, PHP_URL_PATH) ?? '');
                if (str_ends_with($path, '.pdf')) {
                    continue;
                }

                // Skip known-blocked domains
                $host = parse_url($url, PHP_URL_HOST) ?? '';
                if ($this->isBlockedDomain($host)) {
                    continue;
                }

                // Check that the page is actually about this work, not just citing it.
                // Compare our citation title against the search result's page title.
                $pageTitle = $result['title'] ?? '';
                $pageTitleScore = $this->pageTitleSimilarity($title, $pageTitle);
                if ($pageTitleScore < 0.3) {
                    Log::debug('BraveSearchService: page title mismatch', [
                        'citationTitle' => $title,
                        'pageTitle'     => $pageTitle,
                        'score'         => $pageTitleScore,
                        'url'           => $url,
                    ]);
                    continue;
                }

                $tried++;

                $text = $this->webFetch->fetchAndValidate($url, $title);

                if ($text) {
                    $stubBookId = $this->webFetch->createWebStubWithNodes(
                        $db,
                        $title,
                        $author,
                        $year,
                        $text,
                        $url
                    );

                    if ($stubBookId) {
                        Log::info('BraveSearchService resolved citation via web search', [
                            'title' => $title,
                            'url'   => $url,
                        ]);
                        return $stubBookId;
                    }
                }
            }

            return null;
        } catch (\Exception $e) {
            Log::warning('Brave Search request failed: ' . $e->getMessage());
            return null;
        }
    }

    /**
     * Build a search query: quoted title + author surname + year.
     */
    private function buildQuery(string $title, ?string $author, ?int $year): string
    {
        $query = '"' . $title . '"';

        if ($author) {
            // Extract first author's surname
            $parts = explode(';', $author, 2);
            $firstAuthor = trim($parts[0]);
            $nameParts = explode(',', $firstAuthor, 2);
            $surname = trim($nameParts[0]);
            if ($surname) {
                $query .= ' ' . $surname;
            }
        }

        if ($year) {
            $query .= ' ' . $year;
        }

        return $query;
    }

    /**
     * Compare the citation title against a search result's page title.
     * Uses Jaccard word-overlap (same logic as OpenAlexService::titleSimilarity).
     * A page *about* the cited work will have the title in its <title> tag;
     * a page that merely *cites* it will have its own unrelated page title.
     */
    private function pageTitleSimilarity(string $citationTitle, string $pageTitle): float
    {
        $stopWords = ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'by', 'with', 'from', 'at', 'is', 'as', 'pdf'];

        $tokenise = function (string $text) use ($stopWords): array {
            $text = mb_strtolower($text);
            $text = preg_replace('/[^\w\s]/u', ' ', $text);
            $words = preg_split('/\s+/', $text, -1, PREG_SPLIT_NO_EMPTY);
            return array_values(array_diff($words, $stopWords));
        };

        $citationWords = $tokenise($citationTitle);
        $pageWords     = $tokenise($pageTitle);

        if (empty($citationWords) || empty($pageWords)) {
            return 0.0;
        }

        $intersection = count(array_intersect($citationWords, $pageWords));
        $union        = count(array_unique(array_merge($citationWords, $pageWords)));

        return $union > 0 ? $intersection / $union : 0.0;
    }

    /**
     * Check if a host matches a blocked domain.
     */
    private function isBlockedDomain(string $host): bool
    {
        $host = strtolower($host);
        foreach (self::BLOCKED_DOMAINS as $blocked) {
            if ($host === $blocked || str_ends_with($host, '.' . $blocked)) {
                return true;
            }
        }
        return false;
    }
}
