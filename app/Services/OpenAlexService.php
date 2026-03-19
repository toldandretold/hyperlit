<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use App\Models\PgLibrary;

class OpenAlexService
{
    public const BASE_URL = 'https://api.openalex.org';
    public const USER_AGENT = 'Hyperlit/1.0 (mailto:hello@hyperlit.app)';
    public const SELECT_FIELDS = 'id,title,authorships,publication_year,primary_location,best_oa_location,doi,biblio,open_access,type,language,cited_by_count';

    /**
     * Fetch works from OpenAlex by search query and normalise them.
     *
     * @return array<int, array>
     */
    public function fetchFromOpenAlex(string $query, int $limit = 10, int $page = 1): array
    {
        $response = Http::withHeaders([
            'User-Agent' => self::USER_AGENT,
        ])->get(self::BASE_URL . '/works', [
            'search'   => $query,
            'per_page' => $limit,
            'page'     => $page,
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
     * Fetch works by author name from OpenAlex (two-step: resolve author -> fetch works).
     *
     * @return array<int, array>
     */
    public function fetchFromOpenAlexByAuthor(string $query, int $limit = 10): array
    {
        $authorResponse = Http::withHeaders([
            'User-Agent' => self::USER_AGENT,
        ])->get(self::BASE_URL . '/authors', [
            'search'   => $query,
            'per_page' => 1,
            'select'   => 'id',
        ]);

        if (!$authorResponse->successful()) {
            return [];
        }

        $authors = $authorResponse->json('results') ?? [];
        if (empty($authors)) {
            return [];
        }

        $authorId = $authors[0]['id'] ?? null;
        if (!$authorId) {
            return [];
        }

        $worksResponse = Http::withHeaders([
            'User-Agent' => self::USER_AGENT,
        ])->get(self::BASE_URL . '/works', [
            'filter'   => 'authorships.author.id:' . $authorId,
            'per_page' => $limit,
            'sort'     => 'cited_by_count:desc',
            'select'   => self::SELECT_FIELDS,
        ]);

        if (!$worksResponse->successful()) {
            return [];
        }

        $works = $worksResponse->json('results') ?? [];

        return array_map(fn(array $work) => $this->normaliseWork($work), $works);
    }

    /**
     * Fetch a single work by DOI from OpenAlex.
     * Returns a normalised work array, or null if not found.
     */
    public function fetchByDoi(string $doi): ?array
    {
        $response = Http::withHeaders([
            'User-Agent' => self::USER_AGENT,
        ])->get(self::BASE_URL . '/works/doi:' . $doi, [
            'select' => self::SELECT_FIELDS,
        ]);

        if (!$response->successful()) {
            return null;
        }

        $work = $response->json();
        if (empty($work) || empty($work['id'])) {
            return null;
        }

        return $this->normaliseWork($work);
    }

    /**
     * Extract a DOI from HTML content or plain text.
     * Looks for <a href="...doi.org/..."> links first, then plain text DOI patterns.
     */
    public function extractDoi(string $html): ?string
    {
        // 1. Look for DOI links: <a href="https://doi.org/10.xxxx/...">
        if (preg_match('#href=["\']https?://(?:dx\.)?doi\.org/(10\.\d{4,9}/[^\s"\'<>]+)["\']#i', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        // 2. Plain text DOI pattern: doi:10.xxxx/... or https://doi.org/10.xxxx/...
        if (preg_match('#(?:doi:\s*|https?://(?:dx\.)?doi\.org/)(10\.\d{4,9}/[^\s<>]+)#i', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        // 3. Bare DOI: 10.xxxx/... (must start at word boundary)
        if (preg_match('#\b(10\.\d{4,9}/[^\s<>"]+)#', $html, $m)) {
            return rtrim($m[1], '.,;)');
        }

        return null;
    }

    /**
     * Extract the title from a raw citation string (may contain HTML).
     * Bibtex formatting wraps book titles in <i> and article titles in quotes.
     */
    public function extractTitle(string $raw): string
    {
        // 1. HTML italic title: <i>Title</i> or <em>Title</em>
        //    May be wrapped in <a>: <a href="..."><i>Title</i></a>
        if (preg_match('#<(?:i|em)>([^<]+)</(?:i|em)>#i', $raw, $m)) {
            return trim($m[1]);
        }

        // Strip tags for remaining strategies
        $plain = strip_tags($raw);

        // 2. Quoted title: "Title" or \u201CTitle\u201D (curly quotes)
        if (preg_match('/[\x{201C}""]([^\x{201C}\x{201D}""]+)[\x{201D}""]/u', $plain, $m)) {
            return trim($m[1]);
        }

        // 3. Fallback: strip author pattern and year, truncate at first sentence boundary
        $cleaned = preg_replace('/^[A-Z][a-z]+,\s*[A-Z][a-z.]+(?:\s+and\s+[A-Z][a-z]+,\s*[A-Z][a-z.]+)*\.?\s*/', '', $plain);
        $cleaned = preg_replace('/\(?\d{4}\)?[.:]?\s*\d*[-\x{2013}]?\d*\.?/u', '', $cleaned);
        $cleaned = trim($cleaned);

        if (preg_match('/^(.+?)\.\s/', $cleaned, $m)) {
            $title = trim($m[1]);
            if (strlen($title) >= 10) {
                return $title;
            }
        }

        return trim(substr($cleaned, 0, 150));
    }

    /**
     * Compute word-overlap similarity between a search query and a result title.
     * Returns a float between 0.0 (no overlap) and 1.0 (identical words).
     * Uses Jaccard similarity: |intersection| / |union| on lowercased word sets,
     * with common stop words removed.
     */
    public function titleSimilarity(string $query, string $resultTitle): float
    {
        $stopWords = ['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'by', 'with', 'from', 'at', 'is', 'as'];

        $tokenise = function (string $text) use ($stopWords): array {
            $text = mb_strtolower($text);
            $text = preg_replace('/[^\w\s]/u', ' ', $text);
            $words = preg_split('/\s+/', $text, -1, PREG_SPLIT_NO_EMPTY);
            return array_values(array_diff($words, $stopWords));
        };

        $queryWords  = $tokenise($query);
        $resultWords = $tokenise($resultTitle);

        if (empty($queryWords) || empty($resultWords)) {
            return 0.0;
        }

        $intersection = count(array_intersect($queryWords, $resultWords));
        $union        = count(array_unique(array_merge($queryWords, $resultWords)));

        return $union > 0 ? $intersection / $union : 0.0;
    }

    /**
     * Check whether a normalised work is a real citable work (not paratext, component, etc.).
     */
    public function isCitableWork(array $normalised): bool
    {
        $citableTypes = [
            'journal-article', 'article', 'book', 'book-chapter',
            'dissertation', 'proceedings-article', 'report',
            'peer-review', 'monograph', 'reference-entry',
            'proceedings', 'standard', 'posted-content',
        ];

        $type = $normalised['type'] ?? null;

        return $type !== null && in_array($type, $citableTypes, true);
    }

    /**
     * Normalise a raw OpenAlex work object into the shared citation shape.
     */
    public function normaliseWork(array $work): array
    {
        $authorships = $work['authorships'] ?? [];
        $authors = array_map(
            fn($a) => $a['author']['display_name'] ?? 'Unknown',
            array_slice($authorships, 0, 3)
        );
        $author = $authors ? implode('; ', $authors) : null;

        $rawId = $work['id'] ?? null;
        $openalexId = $rawId ? basename($rawId) : null;

        $doi = $work['doi'] ?? null;
        if ($doi && str_starts_with($doi, 'https://doi.org/')) {
            $doi = substr($doi, strlen('https://doi.org/'));
        }

        $pdfUrl = $work['primary_location']['pdf_url']
            ?? $work['best_oa_location']['pdf_url']
            ?? null;

        $firstPage = $work['biblio']['first_page'] ?? null;
        $lastPage  = $work['biblio']['last_page'] ?? null;

        $sanitiseUrl = fn(?string $url): ?string =>
            ($url && filter_var($url, FILTER_VALIDATE_URL) && preg_match('#^https?://#i', $url))
                ? $url
                : null;

        return [
            'book'           => null,
            'title'          => $work['title'] ?? null,
            'author'         => $author,
            'has_nodes'      => false,
            'year'           => $work['publication_year'] ?? null,
            'journal'        => $work['primary_location']['source']['display_name'] ?? null,
            'doi'            => $doi,
            'openalex_id'    => $openalexId,
            'source'         => 'openalex',
            'is_oa'          => $work['open_access']['is_oa'] ?? null,
            'oa_status'      => $work['open_access']['oa_status'] ?? null,
            'oa_url'         => $sanitiseUrl($work['open_access']['oa_url'] ?? null),
            'pdf_url'        => $sanitiseUrl($pdfUrl),
            'work_license'   => $work['primary_location']['license'] ?? null,
            'cited_by_count' => $work['cited_by_count'] ?? null,
            'language'       => $work['language'] ?? null,
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
     * @param array<int, array> $candidates  Already-normalised works
     * @return array<int, array>  Candidates with `book` and `bibtex` populated
     */
    public function upsertLibraryStubs(array $candidates): array
    {
        $openalexIds = array_values(array_filter(array_column($candidates, 'openalex_id')));

        if (empty($openalexIds)) {
            return $candidates;
        }

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
                $bookId = (string) Str::uuid();
                $bibtex = $candidate['bibtex'];
                $doiUrl = $candidate['doi'] ? 'https://doi.org/' . $candidate['doi'] : null;

                try {
                    $now = now()->toDateTimeString();
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
                    Log::warning('OpenAlex stub creation failed for ' . $openalexId . ': ' . $e->getMessage());
                }
            }
        }
        unset($candidate);

        return $candidates;
    }

    /**
     * Create or find a single library stub for a normalised work.
     * Returns the book UUID, or null on failure.
     */
    public function createOrFindStub(array $normalised): ?string
    {
        $result = $this->upsertLibraryStubs([$normalised]);
        return $result[0]['book'] ?? null;
    }

    /**
     * Generate a BibTeX entry string from a raw OpenAlex work.
     */
    public function generateBibtex(array $work): string
    {
        $rawId = $work['id'] ?? null;
        $openalexId = $rawId ? basename($rawId) : 'unknown';

        $type = match ($work['type'] ?? '') {
            'journal-article' => 'article',
            'book'            => 'book',
            'book-chapter'    => 'incollection',
            'conference'      => 'inproceedings',
            'dissertation'    => 'phdthesis',
            default           => 'misc',
        };

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
}
