<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class OpenAlexController extends Controller
{
    private const BASE_URL = 'https://api.openalex.org';
    private const USER_AGENT = 'Hyperlit/1.0 (mailto:hello@hyperlit.app)';
    private const SELECT_FIELDS = 'id,title,authorships,publication_year,primary_location,doi,biblio';

    /**
     * Search OpenAlex works
     * GET /api/search/openalex?q=query&limit=10
     */
    public function search(Request $request)
    {
        $request->validate([
            'q'     => 'required|string|min:2',
            'limit' => 'integer|min:1|max:20',
        ]);

        $query = $request->input('q');
        $limit = min((int) $request->input('limit', 10), 20);

        try {
            $results = $this->fetchFromOpenAlex($query, $limit);

            return response()->json([
                'success' => true,
                'results' => $results,
                'query'   => $query,
                'source'  => 'openalex',
                'count'   => count($results),
            ]);
        } catch (\Exception $e) {
            Log::error('OpenAlex search failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'OpenAlex search failed',
                'error'   => config('app.debug') ? $e->getMessage() : null,
            ], 500);
        }
    }

    /**
     * Resolve a raw bibliography string to candidate OpenAlex works
     * POST /api/openalex/lookup-citation
     * Auth: sanctum required
     */
    public function lookupCitation(Request $request)
    {
        $request->validate([
            'raw' => 'required|string|min:5',
        ]);

        $raw = $request->input('raw');
        $extractedTitle = $this->extractTitle($raw);

        try {
            $results = $this->fetchFromOpenAlex($extractedTitle, 5);

            return response()->json([
                'success'         => true,
                'candidates'      => array_slice($results, 0, 3),
                'extracted_title' => $extractedTitle,
                'raw'             => $raw,
            ]);
        } catch (\Exception $e) {
            Log::error('OpenAlex lookup-citation failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Citation lookup failed',
                'error'   => config('app.debug') ? $e->getMessage() : null,
            ], 500);
        }
    }

    /**
     * Fetch works from OpenAlex and normalise them.
     * Public so SearchController can call it directly.
     *
     * @return array<int, array>
     */
    public function fetchFromOpenAlex(string $query, int $limit = 10): array
    {
        $response = Http::withHeaders([
            'User-Agent' => self::USER_AGENT,
        ])->get(self::BASE_URL . '/works', [
            'search'   => $query,
            'per_page' => $limit,
            'select'   => self::SELECT_FIELDS,
        ]);

        if (!$response->successful()) {
            Log::warning('OpenAlex API returned ' . $response->status() . ' for query: ' . $query);
            return [];
        }

        $works = $response->json('results') ?? [];

        return array_map(fn(array $work) => $this->normaliseWork($work), $works);
    }

    /**
     * Normalise a raw OpenAlex work object into the shared citation shape.
     */
    private function normaliseWork(array $work): array
    {
        // Format up to 3 authors as "Display Name; Display Name"
        $authorships = $work['authorships'] ?? [];
        $authors = array_map(
            fn($a) => $a['author']['display_name'] ?? 'Unknown',
            array_slice($authorships, 0, 3)
        );
        $author = $authors ? implode('; ', $authors) : null;

        // Strip the URL prefix from the OpenAlex ID (e.g. "https://openalex.org/W123" → "W123")
        $rawId = $work['id'] ?? null;
        $openalexId = $rawId ? basename($rawId) : null;

        return [
            'book'        => null,
            'title'       => $work['title'] ?? null,
            'author'      => $author,
            'year'        => $work['publication_year'] ?? null,
            'journal'     => $work['primary_location']['source']['display_name'] ?? null,
            'doi'         => $work['doi'] ?? null,
            'openalex_id' => $openalexId,
            'source'      => 'openalex',
        ];
    }

    /**
     * Heuristically extract the most likely title from a raw citation string.
     * Priority: quoted segment → italic segment → remainder after author pattern.
     */
    private function extractTitle(string $raw): string
    {
        // 1. Quoted title — straight " or curly \x{201C}/\x{201D} quotes (PCRE hex escapes with /u)
        if (preg_match('/[\x{201C}""]([^\x{201C}\x{201D}""]+)[\x{201D}""]/u', $raw, $m)) {
            return trim($m[1]);
        }

        // 2. Italic title (_title_ or *title*)
        if (preg_match('/[_*]([^_*]+)[_*]/', $raw, $m)) {
            return trim($m[1]);
        }

        // 3. Strip leading "Lastname, First." author pattern, year, and page ranges
        $cleaned = preg_replace('/^[A-Z][a-z]+,\s*[A-Z][a-z.]+(?:\s+and\s+[A-Z][a-z]+,\s*[A-Z][a-z.]+)*\.?\s*/', '', $raw);
        $cleaned = preg_replace('/\(?\d{4}\)?[.:]?\s*\d*[-\x{2013}]?\d*\.?/u', '', $cleaned);

        return trim(substr((string) $cleaned, 0, 150));
    }
}
