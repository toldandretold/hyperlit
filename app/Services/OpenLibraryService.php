<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class OpenLibraryService
{
    public const BASE_URL = 'https://openlibrary.org';
    public const SEARCH_FIELDS = 'key,title,author_name,first_publish_year,publisher,isbn,oclc,lccn,subject';

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

        return [
            'book'             => null,
            'title'            => $doc['title'] ?? null,
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
