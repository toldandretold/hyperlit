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

class CitationScanJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 600;
    public int $tries = 1;

    public function __construct(
        private string $scanId,
        private string $bookId,
    ) {}

    public function handle(OpenAlexService $openAlex): void
    {
        $db = DB::connection('pgsql_admin');

        try {
            // Mark scan as running
            $db->table('citation_scans')
                ->where('id', $this->scanId)
                ->update(['status' => 'running', 'updated_at' => now()]);

            // Fetch all bibliography entries for this book
            $entries = $db->table('bibliography')
                ->where('book', $this->bookId)
                ->get();

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

                // Rate limiting: 200ms between API calls
                usleep(200_000);
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
     * Try DOI first, then title search. If matched, set both source_id and foundation_source.
     */
    private function processUnlinkedEntry(object $entry, OpenAlexService $openAlex, $db): array
    {
        $referenceId = $entry->referenceId;
        $content     = $entry->content ?? '';

        // Try DOI extraction from raw HTML content
        $doi = $openAlex->extractDoi($content);
        $matchMethod = null;
        $normalised  = null;

        if ($doi) {
            $normalised = $openAlex->fetchByDoi($doi);
            if ($normalised) {
                $matchMethod = 'doi';
            }
        }

        // Fall back to title search with similarity check
        $searchedTitle = null;
        if (!$normalised) {
            $searchedTitle = $openAlex->extractTitle($content);

            if (strlen($searchedTitle) >= 5) {
                $candidates = $openAlex->fetchFromOpenAlex($searchedTitle, 3);

                // Pick the best citable match above the similarity threshold
                $bestMatch = null;
                $bestScore = 0.0;
                $firstRejectedType = null;
                foreach ($candidates as $candidate) {
                    if (!$openAlex->isCitableWork($candidate)) {
                        $firstRejectedType = $firstRejectedType ?? ($candidate['type'] ?? 'unknown');
                        continue;
                    }
                    $score = $openAlex->titleSimilarity($searchedTitle, $candidate['title'] ?? '');
                    if ($score > $bestScore) {
                        $bestScore = $score;
                        $bestMatch = $candidate;
                    }
                }

                if ($bestMatch && $bestScore >= 0.3) {
                    $normalised = $bestMatch;
                    $matchMethod = 'title_search';
                    $similarityScore = round($bestScore, 3);
                }
            }
        }

        if (!$normalised) {
            return [
                'referenceId'    => $referenceId,
                'status'         => 'no_match',
                'searched_title' => $searchedTitle,
                'best_score'     => isset($bestScore) ? round($bestScore, 3) : null,
                'best_candidate' => isset($bestMatch) ? ($bestMatch['title'] ?? null) : null,
                'rejected_type'  => $firstRejectedType ?? null,
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
            'similarity_score'   => $similarityScore ?? null,
            'openalex_id'        => $normalised['openalex_id'],
            'foundation_book_id' => $stubBookId,
            'is_oa'              => $normalised['is_oa'],
            'oa_url'             => $normalised['oa_url'],
            'pdf_url'            => $normalised['pdf_url'],
        ];
    }

    /**
     * Process a linked bibliography entry (source_id is NOT null).
     * Look up OpenAlex match to enrich with foundation_source. Never modify source_id.
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

        // Try DOI from bibliography content
        $doi = $openAlex->extractDoi($content);
        $normalised = null;
        $matchMethod = null;

        if ($doi) {
            $normalised = $openAlex->fetchByDoi($doi);
            if ($normalised) {
                $matchMethod = 'doi';
            }
        }

        // Fall back: try title from the linked library entry with similarity check
        $searchedTitle = null;
        if (!$normalised) {
            $linkedLib = $db->table('library')
                ->where('book', $sourceId)
                ->select(['title', 'author'])
                ->first();

            if ($linkedLib && !empty($linkedLib->title)) {
                $searchedTitle = $linkedLib->title;
                $candidates = $openAlex->fetchFromOpenAlex($searchedTitle, 3);

                $bestMatch = null;
                $bestScore = 0.0;
                $firstRejectedType = null;
                foreach ($candidates as $candidate) {
                    if (!$openAlex->isCitableWork($candidate)) {
                        $firstRejectedType = $firstRejectedType ?? ($candidate['type'] ?? 'unknown');
                        continue;
                    }
                    $score = $openAlex->titleSimilarity($searchedTitle, $candidate['title'] ?? '');
                    if ($score > $bestScore) {
                        $bestScore = $score;
                        $bestMatch = $candidate;
                    }
                }

                if ($bestMatch && $bestScore >= 0.3) {
                    $normalised = $bestMatch;
                    $matchMethod = 'title_search';
                    $similarityScore = round($bestScore, 3);
                }
            }
        }

        if (!$normalised) {
            return [
                'referenceId'    => $referenceId,
                'status'         => 'no_match',
                'searched_title' => $searchedTitle,
                'best_score'     => isset($bestScore) ? round($bestScore, 3) : null,
                'best_candidate' => isset($bestMatch) ? ($bestMatch['title'] ?? null) : null,
                'rejected_type'  => $firstRejectedType ?? null,
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
            'similarity_score'   => $similarityScore ?? null,
            'openalex_id'        => $normalised['openalex_id'],
            'foundation_book_id' => $stubBookId,
            'is_oa'              => $normalised['is_oa'],
            'oa_url'             => $normalised['oa_url'],
            'pdf_url'            => $normalised['pdf_url'],
        ];
    }
}
