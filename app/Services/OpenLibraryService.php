<?php

namespace App\Services;

use Illuminate\Http\Client\Pool;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class OpenLibraryService
{
    public const BASE_URL = 'https://openlibrary.org';
    public const SEARCH_FIELDS = 'key,title,subtitle,author_name,first_publish_year,publisher,isbn,oclc,lccn,subject';

    /**
     * Search Open Library for books matching the given criteria.
     * Returns an array of normalised work arrays compatible with the library stub shape.
     */
    public function search(string $title, ?string $author = null, int $limit = 5): array
    {
        $params = [
            'title'  => $title,
            'fields' => self::SEARCH_FIELDS,
            'limit'  => $limit,
        ];

        if ($author) {
            $params['author'] = $author;
        }

        try {
            $response = Http::timeout(15)->get(self::BASE_URL . '/search.json', $params);

            if (!$response->successful()) {
                Log::warning('Open Library API returned ' . $response->status() . ' for title: ' . $title);
                return [];
            }

            $docs = $response->json('docs') ?? [];

            return array_map(fn(array $doc) => $this->normaliseDoc($doc), $docs);
        } catch (\Exception $e) {
            Log::warning('Open Library API request failed: ' . $e->getMessage());
            return [];
        }
    }

    /**
     * Search Open Library for multiple queries concurrently using Http::pool.
     * Processes in chunks of 10 with 1s gap to avoid overwhelming the API.
     *
     * @param array $queries Keyed by referenceId: ['ref1' => ['title' => ..., 'author' => ...], ...]
     * @return array Arrays of normalised docs keyed by referenceId
     */
    public function searchBatch(array $queries, int $limit = 5): array
    {
        if (empty($queries)) {
            return [];
        }

        $allResults = [];
        $keys = array_keys($queries);
        $chunks = array_chunk($keys, 10);

        foreach ($chunks as $chunkIndex => $chunkKeys) {
            try {
                $responses = Http::pool(function (Pool $pool) use ($queries, $chunkKeys, $limit) {
                    foreach ($chunkKeys as $key) {
                        $query = $queries[$key];
                        $params = [
                            'title'  => $query['title'],
                            'fields' => self::SEARCH_FIELDS,
                            'limit'  => $limit,
                        ];
                        if (!empty($query['author'])) {
                            $params['author'] = $query['author'];
                        }

                        $pool->as((string) $key)
                            ->timeout(15)
                            ->get(self::BASE_URL . '/search.json', $params);
                    }
                });

                foreach ($chunkKeys as $key) {
                    $response = $responses[(string) $key] ?? null;
                    if ($response instanceof \Illuminate\Http\Client\Response && $response->successful()) {
                        $docs = $response->json('docs') ?? [];
                        $allResults[$key] = array_map(fn(array $doc) => $this->normaliseDoc($doc), $docs);
                    } else {
                        $allResults[$key] = [];
                    }
                }
            } catch (\Exception $e) {
                Log::warning('Open Library batch request failed: ' . $e->getMessage());
                foreach ($chunkKeys as $key) {
                    $allResults[$key] = [];
                }
            }

            if ($chunkIndex < count($chunks) - 1) {
                sleep(1);
            }
        }

        return $allResults;
    }

    /**
     * Fetch the description for a work from the Open Library Works API.
     * $olKey is like "/works/OL262556W".
     */
    public function fetchDescription(string $olKey): ?string
    {
        try {
            $response = Http::timeout(10)->get(self::BASE_URL . $olKey . '.json');

            if (!$response->successful()) {
                return null;
            }

            $description = $response->json('description');

            // Can be a plain string or {"type": "/type/text", "value": "..."}
            if (is_array($description)) {
                $description = $description['value'] ?? null;
            }

            return is_string($description) && strlen($description) > 30 ? trim($description) : null;
        } catch (\Exception $e) {
            Log::warning('Open Library description fetch failed: ' . $e->getMessage());
            return null;
        }
    }

    /**
     * Normalise an Open Library search doc into the shared citation shape
     * used by OpenAlexService::normaliseWork().
     */
    public function normaliseDoc(array $doc): array
    {
        $authors = $doc['author_name'] ?? [];
        $author = $authors ? implode('; ', array_slice($authors, 0, 3)) : null;

        $publishers = $doc['publisher'] ?? [];
        $publisher = $publishers ? $publishers[0] : null;

        $olKey = $doc['key'] ?? null;

        // Combine title + subtitle when available (OL stores them separately)
        $title = $doc['title'] ?? null;
        $subtitle = $doc['subtitle'] ?? null;
        if ($title && $subtitle) {
            $title = $title . ': ' . $subtitle;
        }

        return [
            'book'             => null,
            'title'            => $title,
            'author'           => $author,
            'has_nodes'        => false,
            'year'             => $doc['first_publish_year'] ?? null,
            'journal'          => null,
            'doi'              => null,
            'openalex_id'      => null,
            'open_library_key' => $olKey,
            'source'           => 'openlibrary',
            'is_oa'            => null,
            'oa_status'        => null,
            'oa_url'           => null,
            'pdf_url'          => null,
            'work_license'     => null,
            'cited_by_count'   => null,
            'language'         => null,
            'type'             => 'book',
            'volume'           => null,
            'issue'            => null,
            'pages'            => null,
            'publisher'        => $publisher,
            'bibtex'           => $this->generateBibtex($doc),
        ];
    }

    /**
     * Generate a minimal BibTeX entry from an Open Library doc.
     */
    private function generateBibtex(array $doc): string
    {
        $olKey = $doc['key'] ?? 'unknown';
        $citeKey = str_replace('/', '_', ltrim($olKey, '/'));

        $authors = $doc['author_name'] ?? [];
        $bibtexAuthors = array_map(function (string $name): string {
            $parts = explode(' ', trim($name));
            if (count($parts) === 1) {
                return $parts[0];
            }
            $last = array_pop($parts);
            $first = implode(' ', $parts);
            return $last . ', ' . $first;
        }, $authors);

        $authorStr = implode(' and ', $bibtexAuthors) ?: 'Unknown';
        $title = $doc['title'] ?? '';
        $subtitle = $doc['subtitle'] ?? null;
        if ($title && $subtitle) {
            $title = $title . ': ' . $subtitle;
        }
        $year = $doc['first_publish_year'] ?? '';
        $publishers = $doc['publisher'] ?? [];

        $fields = [
            'author' => $authorStr,
            'title'  => $title,
            'year'   => (string) $year,
        ];

        if (!empty($publishers)) {
            $fields['publisher'] = $publishers[0];
        }

        $isbns = $doc['isbn'] ?? [];
        if (!empty($isbns)) {
            $fields['isbn'] = $isbns[0];
        }

        $lines = ["@book{{$citeKey},"];
        foreach ($fields as $key => $value) {
            $escaped = str_replace('{', '\\{', str_replace('}', '\\}', (string) $value));
            $lines[] = "  {$key} = {{$escaped}},";
        }
        $lines[] = '}';

        return implode("\n", $lines);
    }
}
