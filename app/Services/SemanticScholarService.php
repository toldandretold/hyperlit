<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class SemanticScholarService
{
    public const BASE_URL = 'https://api.semanticscholar.org/graph/v1';

    /**
     * Search Semantic Scholar for papers matching the given title and optional author.
     * Returns an array of normalised work arrays compatible with the shared citation shape.
     *
     * Free API: no key required, 100 requests per 5 minutes.
     */
    public function search(string $title, ?string $author = null, int $limit = 5): array
    {
        $query = $title;
        if ($author) {
            $query .= ' ' . $author;
        }

        for ($attempt = 0; $attempt < 3; $attempt++) {
            try {
                $response = Http::timeout(15)->get(self::BASE_URL . '/paper/search', [
                    'query'  => $query,
                    'fields' => 'title,authors,year,abstract,externalIds,venue',
                    'limit'  => $limit,
                ]);

                if ($response->status() === 429) {
                    $delay = pow(2, $attempt); // 1s, 2s, 4s
                    Log::info("Semantic Scholar rate limited, retry in {$delay}s (attempt " . ($attempt + 1) . '/3)');
                    sleep($delay);
                    continue;
                }

                if (!$response->successful()) {
                    Log::warning('Semantic Scholar API returned ' . $response->status() . ' for query: ' . $title);
                    return [];
                }

                $papers = $response->json('data') ?? [];

                return array_map(fn(array $paper) => $this->normaliseResult($paper), $papers);
            } catch (\Exception $e) {
                Log::warning('Semantic Scholar API request failed: ' . $e->getMessage());
                return [];
            }
        }

        Log::info('Semantic Scholar rate limited, gave up after 3 retries');
        return [];
    }

    /**
     * Normalise a Semantic Scholar paper into the shared citation shape.
     */
    private function normaliseResult(array $paper): array
    {
        $authors = $paper['authors'] ?? [];
        $authorNames = array_map(fn($a) => $a['name'] ?? 'Unknown', array_slice($authors, 0, 3));
        $author = $authorNames ? implode('; ', $authorNames) : null;

        $externalIds = $paper['externalIds'] ?? [];
        $doi = $externalIds['DOI'] ?? null;

        return [
            'book'               => null,
            'title'              => $paper['title'] ?? null,
            'author'             => $author,
            'has_nodes'          => false,
            'year'               => $paper['year'] ?? null,
            'journal'            => $paper['venue'] ?? null,
            'doi'                => $doi,
            'openalex_id'        => null,
            'open_library_key'   => null,
            'semantic_scholar_id' => $paper['paperId'] ?? null,
            'source'             => 'semantic_scholar',
            'is_oa'              => null,
            'oa_status'          => null,
            'oa_url'             => null,
            'pdf_url'            => null,
            'work_license'       => null,
            'cited_by_count'     => null,
            'language'           => null,
            'type'               => null,
            'volume'             => null,
            'issue'              => null,
            'pages'              => null,
            'bibtex'             => '',
            'abstract'           => $paper['abstract'] ?? null,
        ];
    }
}
