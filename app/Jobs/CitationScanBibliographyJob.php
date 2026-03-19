<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use App\Services\OpenAlexService;
use App\Services\OpenLibraryService;
use App\Services\LlmService;

class CitationScanBibliographyJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 600;
    public int $tries = 1;

    public function __construct(
        private string $scanId,
        private string $bookId,
        private ?string $referenceId = null,
    ) {}

    public function handle(OpenAlexService $openAlex): void
    {
        $db = DB::connection('pgsql_admin');

        try {
            // Mark scan as running
            $db->table('citation_scans')
                ->where('id', $this->scanId)
                ->update(['status' => 'running', 'updated_at' => now()]);

            // Fetch bibliography entries (optionally filtered to a single referenceId)
            $query = $db->table('bibliography')->where('book', $this->bookId);
            if ($this->referenceId) {
                $query->where('referenceId', $this->referenceId);
            }
            $entries = $query->get();

            $totalEntries    = $entries->count();
            $alreadyLinked   = 0;
            $newlyResolved   = 0;
            $failedToResolve = 0;
            $enrichedExisting = 0;
            $results         = [];

            $db->table('citation_scans')
                ->where('id', $this->scanId)
                ->update(['total_entries' => $totalEntries, 'updated_at' => now()]);

            foreach ($entries as $entry) {
                $result = $this->processEntry($entry, $openAlex, $db);
                $results[] = $result;

                match ($result['status']) {
                    'already_linked'   => $alreadyLinked++,
                    'newly_resolved'   => $newlyResolved++,
                    'enriched'         => $enrichedExisting++,
                    'no_match'         => $failedToResolve++,
                    'error'            => $failedToResolve++,
                    default            => null,
                };

                // Rate limiting: 500ms between entries (allows ~2 API calls per entry under 10 req/sec polite pool)
                usleep(500_000);
            }

            // Save final results
            $db->table('citation_scans')
                ->where('id', $this->scanId)
                ->update([
                    'status'            => 'completed',
                    'total_entries'     => $totalEntries,
                    'already_linked'    => $alreadyLinked,
                    'newly_resolved'    => $newlyResolved,
                    'failed_to_resolve' => $failedToResolve,
                    'enriched_existing' => $enrichedExisting,
                    'results'           => json_encode($results),
                    'updated_at'        => now(),
                ]);

            Log::info('Citation scan completed', [
                'scan_id'    => $this->scanId,
                'book'       => $this->bookId,
                'total'      => $totalEntries,
                'resolved'   => $newlyResolved,
                'enriched'   => $enrichedExisting,
                'failed'     => $failedToResolve,
            ]);

        } catch (\Exception $e) {
            Log::error('Citation scan failed', [
                'scan_id' => $this->scanId,
                'book'    => $this->bookId,
                'error'   => $e->getMessage(),
            ]);

            $db->table('citation_scans')
                ->where('id', $this->scanId)
                ->update([
                    'status'     => 'failed',
                    'error'      => $e->getMessage(),
                    'updated_at' => now(),
                ]);

            throw $e;
        }
    }

    private function processEntry(object $entry, OpenAlexService $openAlex, $db): array
    {
        $referenceId = $entry->referenceId;
        $content     = $entry->content ?? '';
        $sourceId    = $entry->source_id;

        try {
            if ($sourceId === null) {
                return $this->processUnlinkedEntry($entry, $openAlex, $db);
            } else {
                return $this->processLinkedEntry($entry, $openAlex, $db);
            }
        } catch (\Exception $e) {
            Log::warning('Citation scan entry error', [
                'referenceId' => $referenceId,
                'error'       => $e->getMessage(),
            ]);

            return [
                'referenceId' => $referenceId,
                'status'      => 'error',
                'error'       => $e->getMessage(),
            ];
        }
    }

    /**
     * Process an unlinked bibliography entry (source_id IS null).
     *
     * Resolution order:
     *   0. Extract DOI (regex) + LLM metadata (every entry)
     *   1. DOI lookup on OpenAlex
     *   2. Local library table search (title + metadataScore)
     *   3. OpenAlex title search (metadataScore)
     *   4. Open Library title search (metadataScore)
     *   5. Give up
     */
    private function processUnlinkedEntry(object $entry, OpenAlexService $openAlex, $db): array
    {
        $referenceId = $entry->referenceId;
        $content     = $entry->content ?? '';

        $matchMethod     = null;
        $normalised      = null;
        $similarityScore = null;
        $bestMatch       = null;
        $bestScore       = 0.0;
        $firstRejectedType = null;

        // --- Step 0: Extract DOI + LLM metadata upfront ---
        $doi = $openAlex->extractDoi($content);

        $llmMetadata = null;
        if (config('services.llm.api_key')) {
            $llm = app(LlmService::class);
            $llmMetadata = $llm->extractCitationMetadata($content);

            Log::debug('LLM metadata extraction', [
                'referenceId' => $referenceId,
                'llmMetadata' => $llmMetadata,
            ]);
        }

        // Build the best title we have (LLM preferred, deterministic fallback)
        $searchedTitle = null;
        if ($llmMetadata && !empty($llmMetadata['title']) && strlen($llmMetadata['title']) >= 5) {
            $searchedTitle = $llmMetadata['title'];
        } else {
            $searchedTitle = $openAlex->extractTitle($content);
            if (strlen($searchedTitle) < 5) {
                $searchedTitle = null;
            }
        }

        // --- Step 1: DOI lookup on OpenAlex ---
        if ($doi) {
            $normalised = $openAlex->fetchByDoi($doi);
            if ($normalised) {
                $matchMethod = 'doi';
            }
        }

        // --- Step 2: Local library table (only verified stubs with openalex_id or open_library_key) ---
        if (!$normalised && $searchedTitle) {
            $localMatch = $this->searchLibraryTable($searchedTitle, $llmMetadata, $openAlex, $db);
            if ($localMatch) {
                $db->table('bibliography')
                    ->where('book', $this->bookId)
                    ->where('referenceId', $referenceId)
                    ->update([
                        'source_id'         => $localMatch['book'],
                        'foundation_source' => $localMatch['book'],
                        'updated_at'        => now(),
                    ]);

                return [
                    'referenceId'        => $referenceId,
                    'status'             => 'newly_resolved',
                    'match_method'       => 'library',
                    'searched_title'     => $searchedTitle,
                    'result_title'       => $localMatch['title'],
                    'similarity_score'   => $localMatch['score'],
                    'openalex_id'        => $localMatch['openalex_id'] ?? null,
                    'open_library_key'   => $localMatch['open_library_key'] ?? null,
                    'foundation_book_id' => $localMatch['book'],
                    'is_oa'              => null,
                    'oa_url'             => null,
                    'pdf_url'            => null,
                    'llm_metadata'       => $llmMetadata,
                ];
            }
        }

        // --- Step 3: OpenAlex title search (richest data: DOI, OA, citations, PDF) ---
        if (!$normalised && $searchedTitle) {
            $candidates = $openAlex->fetchFromOpenAlex($searchedTitle, 5);

            foreach ($candidates as $candidate) {
                if (!$openAlex->isCitableWork($candidate)) {
                    $firstRejectedType = $firstRejectedType ?? ($candidate['type'] ?? 'unknown');
                    continue;
                }
                $score = $llmMetadata
                    ? $openAlex->metadataScore($llmMetadata, $candidate)
                    : $openAlex->titleSimilarity($searchedTitle, $candidate['title'] ?? '');
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $bestMatch = $candidate;
                }
            }

            if ($bestMatch && $bestScore >= 0.3) {
                $normalised = $bestMatch;
                $matchMethod = 'openalex';
                $similarityScore = round($bestScore, 3);
            }
        }

        // --- Step 4: Open Library fallback ---
        if (!$normalised && $searchedTitle) {
            $openLibrary = app(OpenLibraryService::class);

            $olAuthor = null;
            if (!empty($llmMetadata['authors'][0])) {
                $parts = explode(',', $llmMetadata['authors'][0], 2);
                $olAuthor = trim($parts[0]);
            }

            $olCandidates = $openLibrary->search($searchedTitle, $olAuthor);

            $bestMatch = null;
            $bestScore = 0.0;
            foreach ($olCandidates as $candidate) {
                $score = $llmMetadata
                    ? $openAlex->metadataScore($llmMetadata, $candidate)
                    : $openAlex->titleSimilarity($searchedTitle, $candidate['title'] ?? '');
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $bestMatch = $candidate;
                }
            }

            if ($bestMatch && $bestScore >= 0.3) {
                $normalised = $bestMatch;
                $matchMethod = 'open_library';
                $similarityScore = round($bestScore, 3);
            }
        }

        // --- Step 5: No match — mark as scanned-but-unresolved ---
        if (!$normalised) {
            $db->table('bibliography')
                ->where('book', $this->bookId)
                ->where('referenceId', $referenceId)
                ->whereNull('foundation_source')
                ->update([
                    'foundation_source' => 'unknown',
                    'updated_at'        => now(),
                ]);

            return [
                'referenceId'    => $referenceId,
                'status'         => 'no_match',
                'searched_title' => $searchedTitle,
                'best_score'     => $bestScore > 0 ? round($bestScore, 3) : null,
                'best_candidate' => $bestMatch ? ($bestMatch['title'] ?? null) : null,
                'rejected_type'  => $firstRejectedType ?? null,
                'llm_metadata'   => $llmMetadata,
            ];
        }

        // Create or find library stub
        $stubBookId = $openAlex->createOrFindStub($normalised);

        if (!$stubBookId) {
            return [
                'referenceId' => $referenceId,
                'status'      => 'error',
                'error'       => 'Failed to create library stub',
            ];
        }

        // Update bibliography: set both source_id and foundation_source
        $db->table('bibliography')
            ->where('book', $this->bookId)
            ->where('referenceId', $referenceId)
            ->update([
                'source_id'         => $stubBookId,
                'foundation_source' => $stubBookId,
                'updated_at'        => now(),
            ]);

        return [
            'referenceId'        => $referenceId,
            'status'             => 'newly_resolved',
            'match_method'       => $matchMethod,
            'searched_title'     => $searchedTitle,
            'result_title'       => $normalised['title'],
            'similarity_score'   => $similarityScore,
            'openalex_id'        => $normalised['openalex_id'] ?? null,
            'open_library_key'   => $normalised['open_library_key'] ?? null,
            'foundation_book_id' => $stubBookId,
            'is_oa'              => $normalised['is_oa'],
            'oa_url'             => $normalised['oa_url'],
            'pdf_url'            => $normalised['pdf_url'],
            'llm_metadata'       => $llmMetadata,
        ];
    }

    /**
     * Search the local library table for a verified matching work.
     * Only returns stubs that have been verified (have openalex_id or open_library_key).
     * Returns ['book' => uuid, 'title' => ..., 'score' => float] or null.
     */
    private function searchLibraryTable(string $title, ?array $llmMetadata, OpenAlexService $openAlex, $db): ?array
    {
        $candidates = $db->table('library')
            ->whereRaw("title ILIKE ?", ['%' . mb_substr($title, 0, 50) . '%'])
            ->where(function ($q) {
                $q->whereNotNull('openalex_id')
                  ->orWhereNotNull('open_library_key');
            })
            ->limit(10)
            ->get(['book', 'title', 'author', 'year', 'openalex_id', 'open_library_key']);

        if ($candidates->isEmpty()) {
            return null;
        }

        $bestMatch = null;
        $bestScore = 0.0;

        foreach ($candidates as $row) {
            $candidate = [
                'title'  => $row->title,
                'author' => $row->author,
                'year'   => $row->year,
            ];

            $score = $llmMetadata
                ? $openAlex->metadataScore($llmMetadata, $candidate)
                : $openAlex->titleSimilarity($title, $row->title ?? '');

            if ($score > $bestScore) {
                $bestScore = $score;
                $bestMatch = $row;
            }
        }

        if ($bestMatch && $bestScore >= 0.5) {
            return [
                'book'             => $bestMatch->book,
                'title'            => $bestMatch->title,
                'score'            => round($bestScore, 3),
                'openalex_id'      => $bestMatch->openalex_id,
                'open_library_key' => $bestMatch->open_library_key,
            ];
        }

        return null;
    }

    /**
     * Process a linked bibliography entry (source_id is NOT null).
     * Look up OpenAlex/OL match to enrich with foundation_source. Never modify source_id.
     *
     * Uses LLM metadata + same resolution chain: DOI → OpenAlex → Open Library.
     * Skips library table search (entry already has a source_id link).
     */
    private function processLinkedEntry(object $entry, OpenAlexService $openAlex, $db): array
    {
        $referenceId = $entry->referenceId;
        $content     = $entry->content ?? '';
        $sourceId    = $entry->source_id;

        // Skip if already has foundation_source
        if (!empty($entry->foundation_source)) {
            return [
                'referenceId' => $referenceId,
                'status'      => 'already_linked',
            ];
        }

        $matchMethod     = null;
        $normalised      = null;
        $similarityScore = null;
        $bestMatch       = null;
        $bestScore       = 0.0;
        $firstRejectedType = null;

        // --- Extract DOI + LLM metadata ---
        $doi = $openAlex->extractDoi($content);

        $llmMetadata = null;
        if (config('services.llm.api_key')) {
            $llm = app(LlmService::class);
            $llmMetadata = $llm->extractCitationMetadata($content);
        }

        // Get title: LLM > linked library entry > deterministic extraction
        $searchedTitle = null;
        if ($llmMetadata && !empty($llmMetadata['title']) && strlen($llmMetadata['title']) >= 5) {
            $searchedTitle = $llmMetadata['title'];
        } else {
            $linkedLib = $db->table('library')
                ->where('book', $sourceId)
                ->select(['title'])
                ->first();
            if ($linkedLib && !empty($linkedLib->title)) {
                $searchedTitle = $linkedLib->title;
            } else {
                $searchedTitle = $openAlex->extractTitle($content);
                if (strlen($searchedTitle) < 5) {
                    $searchedTitle = null;
                }
            }
        }

        // --- Step 1: DOI lookup ---
        if ($doi) {
            $normalised = $openAlex->fetchByDoi($doi);
            if ($normalised) {
                $matchMethod = 'doi';
            }
        }

        // --- Step 2: OpenAlex title search ---
        if (!$normalised && $searchedTitle) {
            $candidates = $openAlex->fetchFromOpenAlex($searchedTitle, 5);

            foreach ($candidates as $candidate) {
                if (!$openAlex->isCitableWork($candidate)) {
                    $firstRejectedType = $firstRejectedType ?? ($candidate['type'] ?? 'unknown');
                    continue;
                }
                $score = $llmMetadata
                    ? $openAlex->metadataScore($llmMetadata, $candidate)
                    : $openAlex->titleSimilarity($searchedTitle, $candidate['title'] ?? '');
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $bestMatch = $candidate;
                }
            }

            if ($bestMatch && $bestScore >= 0.3) {
                $normalised = $bestMatch;
                $matchMethod = 'openalex';
                $similarityScore = round($bestScore, 3);
            }
        }

        // --- Step 3: Open Library fallback ---
        if (!$normalised && $searchedTitle) {
            $openLibrary = app(OpenLibraryService::class);

            $olAuthor = null;
            if (!empty($llmMetadata['authors'][0])) {
                $parts = explode(',', $llmMetadata['authors'][0], 2);
                $olAuthor = trim($parts[0]);
            }

            $olCandidates = $openLibrary->search($searchedTitle, $olAuthor);

            $bestMatch = null;
            $bestScore = 0.0;
            foreach ($olCandidates as $candidate) {
                $score = $llmMetadata
                    ? $openAlex->metadataScore($llmMetadata, $candidate)
                    : $openAlex->titleSimilarity($searchedTitle, $candidate['title'] ?? '');
                if ($score > $bestScore) {
                    $bestScore = $score;
                    $bestMatch = $candidate;
                }
            }

            if ($bestMatch && $bestScore >= 0.3) {
                $normalised = $bestMatch;
                $matchMethod = 'open_library';
                $similarityScore = round($bestScore, 3);
            }
        }

        if (!$normalised) {
            $db->table('bibliography')
                ->where('book', $this->bookId)
                ->where('referenceId', $referenceId)
                ->whereNull('foundation_source')
                ->update([
                    'foundation_source' => 'unknown',
                    'updated_at'        => now(),
                ]);

            return [
                'referenceId'    => $referenceId,
                'status'         => 'no_match',
                'searched_title' => $searchedTitle,
                'best_score'     => $bestScore > 0 ? round($bestScore, 3) : null,
                'best_candidate' => $bestMatch ? ($bestMatch['title'] ?? null) : null,
                'rejected_type'  => $firstRejectedType ?? null,
                'llm_metadata'   => $llmMetadata,
            ];
        }

        // Create or find library stub
        $stubBookId = $openAlex->createOrFindStub($normalised);

        if (!$stubBookId) {
            return [
                'referenceId' => $referenceId,
                'status'      => 'error',
                'error'       => 'Failed to create library stub',
            ];
        }

        // Only set foundation_source — DO NOT modify source_id
        $db->table('bibliography')
            ->where('book', $this->bookId)
            ->where('referenceId', $referenceId)
            ->update([
                'foundation_source' => $stubBookId,
                'updated_at'        => now(),
            ]);

        return [
            'referenceId'        => $referenceId,
            'status'             => 'enriched',
            'match_method'       => $matchMethod,
            'searched_title'     => $searchedTitle,
            'result_title'       => $normalised['title'],
            'similarity_score'   => $similarityScore,
            'openalex_id'        => $normalised['openalex_id'] ?? null,
            'open_library_key'   => $normalised['open_library_key'] ?? null,
            'foundation_book_id' => $stubBookId,
            'is_oa'              => $normalised['is_oa'],
            'oa_url'             => $normalised['oa_url'],
            'pdf_url'            => $normalised['pdf_url'],
            'llm_metadata'       => $llmMetadata,
        ];
    }
}
