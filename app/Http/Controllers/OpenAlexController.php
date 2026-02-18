<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use App\Models\PgLibrary;

class OpenAlexController extends Controller
{
    private const BASE_URL = 'https://api.openalex.org';
    private const USER_AGENT = 'Hyperlit/1.0 (mailto:hello@hyperlit.app)';
    private const SELECT_FIELDS = 'id,title,authorships,publication_year,primary_location,best_oa_location,doi,biblio,open_access,type,language,cited_by_count';

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
     * Save an OpenAlex work as a lightweight library stub so it can be cited.
     * POST /api/openalex/save-to-library
     * No auth required — anonymous users can cite too.
     */
    public function saveToLibrary(Request $request): JsonResponse
    {
        $request->validate([
            'openalex_id' => 'required|string|max:30',
        ]);

        $openalexId = $request->input('openalex_id');

        // Check for an existing stub to avoid duplicates (shared across all users)
        $existing = PgLibrary::where('openalex_id', $openalexId)->first();

        if ($existing) {
            return response()->json([
                'success' => true,
                'book'    => $existing->book,
                'bibtex'  => $existing->bibtex,
            ]);
        }

        // Fetch the full work from OpenAlex
        try {
            $response = Http::withHeaders([
                'User-Agent' => self::USER_AGENT,
            ])->get(self::BASE_URL . '/works/' . $openalexId, [
                'select' => self::SELECT_FIELDS,
            ]);

            if (!$response->successful()) {
                Log::warning('OpenAlex /works/' . $openalexId . ' returned ' . $response->status());
                return response()->json([
                    'success' => false,
                    'message' => 'Could not fetch work from OpenAlex',
                ], 502);
            }

            $work = $response->json();
        } catch (\Exception $e) {
            Log::error('OpenAlex saveToLibrary fetch failed: ' . $e->getMessage());
            return response()->json([
                'success' => false,
                'message' => 'Failed to reach OpenAlex',
            ], 502);
        }

        $normalised = $this->normaliseWork($work);
        $bibtex = $this->generateBibtex($work);

        $bookId = (string) Str::uuid();
        $doiUrl = $normalised['doi'] ? 'https://doi.org/' . $normalised['doi'] : null;

        $now = now()->toDateTimeString();
        // Use admin connection to bypass RLS — same pattern as DailyStatsJob
        DB::connection('pgsql_admin')->table('library')->insert([
            'book'           => $bookId,
            'has_nodes'      => false,
            'listed'         => false,
            'visibility'     => 'public',
            'openalex_id'    => $openalexId,
            'bibtex'         => $bibtex,
            'title'          => $normalised['title'],
            'author'         => $normalised['author'],
            'year'           => $normalised['year'],
            'journal'        => $normalised['journal'],
            'doi'            => $normalised['doi'],
            'is_oa'          => $normalised['is_oa'],
            'oa_status'      => $normalised['oa_status'],
            'oa_url'         => $normalised['oa_url'],
            'pdf_url'        => $normalised['pdf_url'],
            'work_license'   => $normalised['work_license'],
            'cited_by_count' => $normalised['cited_by_count'],
            'language'       => $normalised['language'],
            'type'           => $normalised['type'],
            'volume'         => $normalised['volume'],
            'issue'          => $normalised['issue'],
            'pages'          => $normalised['pages'],
            'url'            => $doiUrl,
            'creator'        => 'OpenAlex',
            'creator_token'  => null,
            'timestamp'      => time(),
            'raw_json'       => json_encode([
                'book'        => $bookId,
                'title'       => $normalised['title'],
                'author'      => $normalised['author'],
                'year'        => $normalised['year'],
                'type'        => $normalised['type'],
                'journal'     => $normalised['journal'],
                'doi'         => $normalised['doi'],
                'url'         => $doiUrl,
                'openalex_id' => $openalexId,
                'bibtex'      => $bibtex,
                'visibility'  => 'public',
                'creator'     => 'OpenAlex',
            ]),
            'created_at'     => $now,
            'updated_at'     => $now,
        ]);

        return response()->json([
            'success' => true,
            'book'    => $bookId,
            'bibtex'  => $bibtex,
        ]);
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
     * Includes generated bibtex and all fields needed for library stub creation.
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

        // DOI: strip the URL prefix if present
        $doi = $work['doi'] ?? null;
        if ($doi && str_starts_with($doi, 'https://doi.org/')) {
            $doi = substr($doi, strlen('https://doi.org/'));
        }

        // PDF URL: prefer primary_location, fall back to best_oa_location
        $pdfUrl = $work['primary_location']['pdf_url']
            ?? $work['best_oa_location']['pdf_url']
            ?? null;

        $firstPage = $work['biblio']['first_page'] ?? null;
        $lastPage  = $work['biblio']['last_page'] ?? null;

        return [
            'book'           => null,
            'title'          => $work['title'] ?? null,
            'author'         => $author,
            'year'           => $work['publication_year'] ?? null,
            'journal'        => $work['primary_location']['source']['display_name'] ?? null,
            'doi'            => $doi,
            'openalex_id'    => $openalexId,
            'source'         => 'openalex',
            'is_oa'          => $work['open_access']['is_oa'] ?? null,
            'oa_status'      => $work['open_access']['oa_status'] ?? null,
            'oa_url'         => $work['open_access']['oa_url'] ?? null,
            'pdf_url'        => $pdfUrl,
            'work_license'   => $work['primary_location']['license'] ?? null,
            'cited_by_count' => $work['cited_by_count'] ?? null,
            'language'       => $work['language'] ?? null,
            // Extra fields for stub creation
            'type'           => $work['type'] ?? null,
            'volume'         => $work['biblio']['volume'] ?? null,
            'issue'          => $work['biblio']['issue'] ?? null,
            'pages'          => ($firstPage && $lastPage) ? $firstPage . '–' . $lastPage : null,
            'bibtex'         => $this->generateBibtex($work),
        ];
    }

    /**
     * Batch-upsert OpenAlex search results as lightweight library stubs.
     *
     * For each candidate:
     *  - If a stub with that openalex_id already exists, attach its book UUID.
     *  - Otherwise, create a new stub (has_nodes=false, listed=false) and attach the new UUID.
     *
     * Returns the candidates array with `book` and `bibtex` populated on each item.
     *
     * @param array<int, array> $candidates  Already-normalised works (from normaliseWork)
     */
    public function upsertLibraryStubs(array $candidates): array
    {
        $openalexIds = array_values(array_filter(array_column($candidates, 'openalex_id')));

        if (empty($openalexIds)) {
            return $candidates;
        }

        // Single query for all existing stubs
        $existing = PgLibrary::whereIn('openalex_id', $openalexIds)
            ->select(['book', 'openalex_id', 'bibtex'])
            ->get()
            ->keyBy('openalex_id');

        $timestamp = time();

        foreach ($candidates as &$candidate) {
            $openalexId = $candidate['openalex_id'] ?? null;
            if (!$openalexId) continue;

            if ($existing->has($openalexId)) {
                $stub = $existing->get($openalexId);
                $candidate['book']   = $stub->book;
                $candidate['bibtex'] = $stub->bibtex;
            } else {
                $bookId  = (string) Str::uuid();
                $bibtex  = $candidate['bibtex'];
                $doiUrl  = $candidate['doi'] ? 'https://doi.org/' . $candidate['doi'] : null;

                try {
                    $now = now()->toDateTimeString();
                    // Use admin connection to bypass RLS — same pattern as DailyStatsJob
                    DB::connection('pgsql_admin')->table('library')->insert([
                        'book'           => $bookId,
                        'has_nodes'      => false,
                        'listed'         => false,
                        'visibility'     => 'public',
                        'openalex_id'    => $openalexId,
                        'bibtex'         => $bibtex,
                        'title'          => $candidate['title'],
                        'author'         => $candidate['author'],
                        'year'           => $candidate['year'],
                        'journal'        => $candidate['journal'],
                        'doi'            => $candidate['doi'],
                        'is_oa'          => $candidate['is_oa'],
                        'oa_status'      => $candidate['oa_status'],
                        'oa_url'         => $candidate['oa_url'],
                        'pdf_url'        => $candidate['pdf_url'],
                        'work_license'   => $candidate['work_license'],
                        'cited_by_count' => $candidate['cited_by_count'],
                        'language'       => $candidate['language'],
                        'type'           => $candidate['type'],
                        'volume'         => $candidate['volume'],
                        'issue'          => $candidate['issue'],
                        'pages'          => $candidate['pages'],
                        'url'            => $doiUrl,
                        'creator'        => 'OpenAlex',
                        'creator_token'  => null,
                        'timestamp'      => $timestamp,
                        'raw_json'       => json_encode([
                            'book'        => $bookId,
                            'title'       => $candidate['title'],
                            'author'      => $candidate['author'],
                            'year'        => $candidate['year'],
                            'type'        => $candidate['type'],
                            'journal'     => $candidate['journal'],
                            'doi'         => $candidate['doi'],
                            'url'         => $doiUrl,
                            'openalex_id' => $openalexId,
                            'bibtex'      => $bibtex,
                            'visibility'  => 'public',
                            'creator'     => 'OpenAlex',
                        ]),
                        'created_at'     => $now,
                        'updated_at'     => $now,
                    ]);

                    $candidate['book']   = $bookId;
                    $candidate['bibtex'] = $bibtex;
                } catch (\Exception $e) {
                    // Don't fail the search if one stub can't be created
                    Log::warning('OpenAlex stub creation failed for ' . $openalexId . ': ' . $e->getMessage());
                }
            }
        }
        unset($candidate);

        return $candidates;
    }

    /**
     * Generate a BibTeX entry string from a raw OpenAlex work.
     */
    private function generateBibtex(array $work): string
    {
        $rawId = $work['id'] ?? null;
        $openalexId = $rawId ? basename($rawId) : 'unknown';

        // BibTeX entry type
        $type = match ($work['type'] ?? '') {
            'journal-article' => 'article',
            'book'            => 'book',
            'book-chapter'    => 'incollection',
            'conference'      => 'inproceedings',
            'dissertation'    => 'phdthesis',
            default           => 'misc',
        };

        // Authors: BibTeX expects "Last, First and Last2, First2"
        // OpenAlex display_name is "First Last" — reverse last word as surname heuristic
        $authorships = $work['authorships'] ?? [];
        $bibtexAuthors = array_map(function ($a) {
            $name = $a['author']['display_name'] ?? 'Unknown';
            $parts = explode(' ', trim($name));
            if (count($parts) === 1) {
                return $parts[0];
            }
            $last = array_pop($parts);
            $first = implode(' ', $parts);
            return $last . ', ' . $first;
        }, $authorships);

        $authorStr = implode(' and ', $bibtexAuthors) ?: 'Unknown';

        $title  = $work['title'] ?? '';
        $year   = $work['publication_year'] ?? '';
        $journal = $work['primary_location']['source']['display_name'] ?? null;
        $volume  = $work['biblio']['volume'] ?? null;
        $number  = $work['biblio']['issue'] ?? null;
        $firstPage = $work['biblio']['first_page'] ?? null;
        $lastPage  = $work['biblio']['last_page'] ?? null;
        $pages = ($firstPage && $lastPage) ? $firstPage . '--' . $lastPage : ($firstPage ?? null);

        $doi = $work['doi'] ?? null;
        if ($doi && str_starts_with($doi, 'https://doi.org/')) {
            $doi = substr($doi, strlen('https://doi.org/'));
        }

        $doiUrl = $doi ? 'https://doi.org/' . $doi : null;

        // Build field lines
        $fields = [
            'author' => $authorStr,
            'title'  => $title,
            'year'   => (string) $year,
        ];

        if ($journal) {
            $fieldKey = in_array($type, ['inproceedings']) ? 'booktitle' : 'journal';
            $fields[$fieldKey] = $journal;
        }
        if ($volume)  $fields['volume'] = $volume;
        if ($number)  $fields['number'] = $number;
        if ($pages)   $fields['pages']  = $pages;
        if ($doi)     $fields['doi']    = $doi;
        if ($doiUrl)  $fields['url']    = $doiUrl;

        $lines = ["@{$type}{{$openalexId},"];
        foreach ($fields as $key => $value) {
            $escaped = str_replace('{', '\\{', str_replace('}', '\\}', (string) $value));
            $lines[] = "  {$key} = {{$escaped}},";
        }
        $lines[] = '}';

        return implode("\n", $lines);
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
