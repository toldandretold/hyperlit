<?php

namespace App\Services\OpenAlex;

use App\Models\PgLibrary;
use App\Services\OpenLibraryService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * Persists normalised works as lightweight `library` stub rows (no nodes,
 * unlisted, public). Writes go through the pgsql_admin connection — stub
 * creation happens from queue jobs and system flows where no user session
 * exists for RLS.
 */
class LibraryStubWriter
{
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
                        'publisher'      => $candidate['publisher'] ?? null,
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
                        'abstract'       => $candidate['abstract'] ?? null,
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
                            'publisher'   => $candidate['publisher'] ?? null,
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
        // For non-OpenAlex sources (e.g. Open Library), use the generic path
        if (empty($normalised['openalex_id'])) {
            return $this->createStubDirect($normalised);
        }

        $result = $this->upsertLibraryStubs([$normalised]);
        return $result[0]['book'] ?? null;
    }

    /**
     * Create a library stub directly from a normalised work (any source).
     * Deduplicates by open_library_key if present, then by title+year.
     */
    private function createStubDirect(array $normalised): ?string
    {
        $title  = $normalised['title'] ?? null;
        $author = $normalised['author'] ?? null;
        $year   = $normalised['year'] ?? null;
        $olKey  = $normalised['open_library_key'] ?? null;

        if (!$title) {
            return null;
        }

        // Check for existing stub by open_library_key first
        if ($olKey) {
            $existing = DB::connection('pgsql_admin')->table('library')
                ->where('open_library_key', $olKey)
                ->first(['book', 'bibtex']);
            if ($existing) {
                return $existing->book;
            }
        }

        // Fallback dedup by title+year
        $query = DB::connection('pgsql_admin')->table('library')
            ->whereRaw('LOWER(title) = ?', [mb_strtolower($title)]);
        if ($year) {
            $query->where('year', $year);
        }
        $existing = $query->first(['book', 'bibtex']);

        if ($existing) {
            return $existing->book;
        }

        $bookId = (string) Str::uuid();
        $source = $normalised['source'] ?? 'unknown';
        $bibtex = $normalised['bibtex'] ?? '';
        $url    = $olKey ? 'https://openlibrary.org' . $olKey : null;

        // Fetch description from Open Library Works API if available
        $abstract = $normalised['abstract'] ?? null;
        if (!$abstract && $olKey) {
            $abstract = app(OpenLibraryService::class)->fetchDescription($olKey);
        }

        try {
            $now = now()->toDateTimeString();
            DB::connection('pgsql_admin')->table('library')->insert([
                'book'              => $bookId,
                'has_nodes'         => false,
                'listed'            => false,
                'visibility'        => 'public',
                'openalex_id'       => null,
                'open_library_key'  => $olKey,
                'bibtex'            => $bibtex,
                'title'             => $title,
                'author'            => $author,
                'year'              => $year,
                'journal'           => $normalised['journal'] ?? null,
                'doi'               => null,
                'is_oa'          => null,
                'oa_status'      => null,
                'oa_url'         => null,
                'pdf_url'        => null,
                'work_license'   => null,
                'cited_by_count' => null,
                'language'       => null,
                'type'           => $normalised['type'] ?? null,
                'volume'         => null,
                'issue'          => null,
                'pages'          => null,
                'abstract'       => $abstract,
                'url'            => $url,
                'creator'        => ucfirst($source),
                'creator_token'  => null,
                'timestamp'      => time(),
                'raw_json'       => json_encode([
                    'book'              => $bookId,
                    'title'             => $title,
                    'author'            => $author,
                    'year'              => $year,
                    'type'              => $normalised['type'] ?? null,
                    'publisher'         => $normalised['publisher'] ?? null,
                    'open_library_key'  => $olKey,
                    'url'               => $url,
                    'bibtex'            => $bibtex,
                    'visibility'        => 'public',
                    'creator'           => ucfirst($source),
                ]),
                'created_at'     => $now,
                'updated_at'     => $now,
            ]);

            return $bookId;
        } catch (\Exception $e) {
            Log::warning("Library stub creation failed ({$source}): " . $e->getMessage());
            return null;
        }
    }
}
