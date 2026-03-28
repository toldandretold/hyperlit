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
use App\Services\WebFetchService;
use App\Services\SemanticScholarService;
use App\Services\BraveSearchService;

class CitationScanBibliographyJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 3600; // 1 hour — LLM batch extraction + external API lookups
    public int $tries = 1;

    public function __construct(
        private string $scanId,
        private string $bookId,
        private ?string $referenceId = null,
        private bool $force = false,
    ) {
        $this->onQueue('citation-pipeline');
    }

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

            // Force mode: clear existing matches so entries go through resolution fresh
            if ($this->force) {
                $resetQuery = $db->table('bibliography')->where('book', $this->bookId);
                if ($this->referenceId) {
                    $resetQuery->where('referenceId', $this->referenceId);
                }
                $resetCount = $resetQuery->update([
                    'source_id'         => null,
                    'foundation_source' => null,
                    'updated_at'        => now(),
                ]);

                Log::info('Force mode: cleared matches', [
                    'scan_id' => $this->scanId,
                    'reset'   => $resetCount,
                ]);

                // Re-fetch entries after reset so in-memory objects reflect nulled columns
                $refetchQuery = $db->table('bibliography')->where('book', $this->bookId);
                if ($this->referenceId) {
                    $refetchQuery->where('referenceId', $this->referenceId);
                }
                $entries = $refetchQuery->get();
            }

            // Separate entries: already_linked (skip) vs needs_resolution
            $needsResolution = [];
            foreach ($entries as $entry) {
                if ($entry->source_id !== null && !empty($entry->foundation_source)) {
                    $results[] = [
                        'referenceId' => $entry->referenceId,
                        'status'      => 'already_linked',
                    ];
                    $alreadyLinked++;
                } else {
                    $needsResolution[] = $entry;
                }
            }

            if (empty($needsResolution)) {
                $this->saveScanResults($db, $totalEntries, $alreadyLinked, $newlyResolved, $failedToResolve, $enrichedExisting, $results);
                return;
            }

            // Pre-batch LLM metadata extraction for all entries that need it
            $llmMetadataMap = [];
            if (config('services.llm.api_key')) {
                $llm = app(LlmService::class);
                $toExtract = [];
                foreach ($needsResolution as $entry) {
                    $toExtract[$entry->referenceId] = $entry->content ?? '';
                }

                if (!empty($toExtract)) {
                    Log::info('Batch extracting LLM metadata', [
                        'scan_id' => $this->scanId,
                        'count'   => count($toExtract),
                    ]);
                    $llmMetadataMap = $llm->extractCitationMetadataBatch($toExtract);
                }
            }

            // Build pool of unresolved entries
            $pool = [];
            foreach ($needsResolution as $entry) {
                $refId   = $entry->referenceId;
                $content = $entry->content ?? '';
                $llmMetadata = $llmMetadataMap[$refId] ?? null;

                // Extract best title: LLM preferred, then linked library, then deterministic
                $searchedTitle = null;
                if ($llmMetadata && !empty($llmMetadata['title']) && strlen($llmMetadata['title']) >= 5) {
                    $searchedTitle = $llmMetadata['title'];
                } else {
                    if ($entry->source_id !== null) {
                        $linkedLib = $db->table('library')
                            ->where('book', $entry->source_id)
                            ->select(['title'])
                            ->first();
                        if ($linkedLib && !empty($linkedLib->title)) {
                            $searchedTitle = $linkedLib->title;
                        }
                    }
                    if (!$searchedTitle) {
                        $searchedTitle = $openAlex->extractTitle($content);
                        if (strlen($searchedTitle) < 5) {
                            $searchedTitle = null;
                        }
                    }
                }

                $pool[$refId] = [
                    'entry'         => $entry,
                    'referenceId'   => $refId,
                    'content'       => $content,
                    'isLinked'      => $entry->source_id !== null,
                    'llmMetadata'   => $llmMetadata,
                    'searchedTitle' => $searchedTitle,
                    'doi'           => null,
                ];
            }

            Log::info('Wave resolution starting', [
                'scan_id'   => $this->scanId,
                'pool_size' => count($pool),
            ]);

            // ── Wave 1: DOI extraction (regex — instant, then merge LLM-extracted DOIs) ──
            foreach ($pool as $refId => &$item) {
                $item['doi'] = $openAlex->extractDoi($item['content']);
            }
            unset($item);

            // Merge LLM-extracted DOIs for entries where regex found nothing
            foreach ($pool as $refId => &$item) {
                if (!$item['doi'] && !empty($item['llmMetadata']['doi'])) {
                    $item['doi'] = $item['llmMetadata']['doi'];
                }
            }
            unset($item);

            // ── Wave 2: DOI lookup on OpenAlex (Http::pool) ──
            $doisToLookup = [];
            foreach ($pool as $refId => $item) {
                if ($item['doi']) {
                    $doisToLookup[$refId] = $item['doi'];
                }
            }
            if (!empty($doisToLookup)) {
                Log::info('Wave 2: DOI lookup', ['count' => count($doisToLookup)]);
                $doiResults = $openAlex->fetchByDoiBatch($doisToLookup);
                foreach ($doiResults as $refId => $normalised) {
                    if ($normalised && isset($pool[$refId])) {
                        $result = $this->resolveWithNormalised($pool[$refId], $normalised, 'doi', null, $openAlex, $db);
                        if ($result) {
                            $results[] = $result;
                            match ($result['status']) {
                                'newly_resolved' => $newlyResolved++,
                                'enriched'       => $enrichedExisting++,
                                default          => $failedToResolve++,
                            };
                            unset($pool[$refId]);
                        }
                    }
                }
            }

            // ── Wave 3: Local library table search (DB queries — no HTTP) ──
            if (!empty($pool)) {
                Log::info('Wave 3: Library table search', ['remaining' => count($pool)]);
                foreach ($pool as $refId => $item) {
                    if (!$item['searchedTitle']) {
                        continue;
                    }
                    $localMatch = $this->searchLibraryTable($item['searchedTitle'], $item['llmMetadata'], $openAlex, $db);
                    if ($localMatch) {
                        $updateData = $item['isLinked']
                            ? ['foundation_source' => $localMatch['book'], 'updated_at' => now()]
                            : ['source_id' => $localMatch['book'], 'foundation_source' => $localMatch['book'], 'updated_at' => now()];

                        $db->table('bibliography')
                            ->where('book', $this->bookId)
                            ->where('referenceId', $refId)
                            ->update($updateData);

                        $results[] = [
                            'referenceId'        => $refId,
                            'status'             => $item['isLinked'] ? 'enriched' : 'newly_resolved',
                            'match_method'       => 'library',
                            'searched_title'     => $item['searchedTitle'],
                            'result_title'       => $localMatch['title'],
                            'similarity_score'   => $localMatch['score'],
                            'openalex_id'        => $localMatch['openalex_id'] ?? null,
                            'open_library_key'   => $localMatch['open_library_key'] ?? null,
                            'foundation_book_id' => $localMatch['book'],
                            'llm_metadata'       => $item['llmMetadata'],
                        ];
                        $item['isLinked'] ? $enrichedExisting++ : $newlyResolved++;
                        unset($pool[$refId]);
                    }
                }
            }

            // ── Wave 4: OpenAlex title search (Http::pool) ──
            if (!empty($pool)) {
                $titlesToSearch = [];
                foreach ($pool as $refId => $item) {
                    if ($item['searchedTitle']) {
                        $titlesToSearch[$refId] = $item['searchedTitle'];
                    }
                }
                if (!empty($titlesToSearch)) {
                    Log::info('Wave 4: OpenAlex title search', ['count' => count($titlesToSearch)]);
                    $yearFilters = [];
                    foreach ($pool as $refId => $item) {
                        if ($item['searchedTitle'] && !empty($item['llmMetadata']['year'])) {
                            $yearFilters[$refId] = $item['llmMetadata']['year'];
                        }
                    }
                    $oaResults = $openAlex->searchBatch($titlesToSearch, 5, $yearFilters);
                    foreach ($oaResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        $bestMatch = null;
                        $bestScore = 0.0;
                        foreach ($candidates as $candidate) {
                            if (!$openAlex->isCitableWork($candidate)) {
                                Log::debug('Wave 4: rejected non-citable type', [
                                    'refId' => $refId,
                                    'title' => $candidate['title'] ?? null,
                                    'type'  => $candidate['type'] ?? null,
                                ]);
                                continue;
                            }
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $pool[$refId]['searchedTitle'];
                            $score   = $llmMeta
                                ? $openAlex->metadataScore($llmMeta, $candidate)
                                : $openAlex->titleSimilarity($title, $candidate['title'] ?? '');
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                            }
                        }
                        if ($bestMatch && $bestScore <= 0.3) {
                            Log::info('Wave 4: best candidate below threshold', [
                                'refId'         => $refId,
                                'bestScore'     => $bestScore,
                                'bestTitle'     => $bestMatch['title'] ?? null,
                                'searchedTitle' => $pool[$refId]['searchedTitle'],
                            ]);
                        }
                        if ($bestMatch && $bestScore > 0.3) {
                            $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'openalex', round($bestScore, 3), $openAlex, $db);
                            if ($result) {
                                $results[] = $result;
                                match ($result['status']) {
                                    'newly_resolved' => $newlyResolved++,
                                    'enriched'       => $enrichedExisting++,
                                    default          => $failedToResolve++,
                                };
                                unset($pool[$refId]);
                            }
                        }
                    }
                }

                // ── Wave 4b: Retry failed entries with shortened title (main title before colon) ──
                $retryTitles = [];
                $retryYearFilters = [];
                foreach ($pool as $refId => $item) {
                    if (!$item['searchedTitle']) {
                        continue;
                    }
                    // Only retry if the title has a subtitle separator (colon or em-dash)
                    if (preg_match('/^(.{10,}?)\s*[:\x{2013}\x{2014}]\s/u', $item['searchedTitle'], $m)) {
                        $shortened = trim($m[1]);
                        if ($shortened !== $item['searchedTitle'] && strlen($shortened) >= 10) {
                            $retryTitles[$refId] = $shortened;
                            if (!empty($item['llmMetadata']['year'])) {
                                $retryYearFilters[$refId] = $item['llmMetadata']['year'];
                            }
                        }
                    }
                }
                if (!empty($retryTitles)) {
                    Log::info('Wave 4b: Retry with shortened titles', ['count' => count($retryTitles)]);
                    $oaRetryResults = $openAlex->searchBatch($retryTitles, 5, $retryYearFilters);
                    foreach ($oaRetryResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        $bestMatch = null;
                        $bestScore = 0.0;
                        foreach ($candidates as $candidate) {
                            if (!$openAlex->isCitableWork($candidate)) {
                                continue;
                            }
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $pool[$refId]['searchedTitle'];
                            $score   = $llmMeta
                                ? $openAlex->metadataScore($llmMeta, $candidate)
                                : $openAlex->titleSimilarity($title, $candidate['title'] ?? '');
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                            }
                        }
                        if ($bestMatch && $bestScore > 0.3) {
                            Log::info('Wave 4b: matched with shortened title', [
                                'refId'          => $refId,
                                'shortenedTitle' => $retryTitles[$refId],
                                'resultTitle'    => $bestMatch['title'] ?? null,
                                'score'          => $bestScore,
                            ]);
                            $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'openalex', round($bestScore, 3), $openAlex, $db);
                            if ($result) {
                                $results[] = $result;
                                match ($result['status']) {
                                    'newly_resolved' => $newlyResolved++,
                                    'enriched'       => $enrichedExisting++,
                                    default          => $failedToResolve++,
                                };
                                unset($pool[$refId]);
                            }
                        }
                    }
                }
            }

            // ── Wave 5: Open Library search (Http::pool) ──
            if (!empty($pool)) {
                $olQueries = [];
                foreach ($pool as $refId => $item) {
                    if (!$item['searchedTitle']) {
                        continue;
                    }
                    $olAuthor = null;
                    if (!empty($item['llmMetadata']['authors'][0])) {
                        $parts = explode(',', $item['llmMetadata']['authors'][0], 2);
                        $olAuthor = trim($parts[0]);
                    }
                    $olQueries[$refId] = ['title' => $item['searchedTitle'], 'author' => $olAuthor];
                }
                if (!empty($olQueries)) {
                    Log::info('Wave 5: Open Library search', ['count' => count($olQueries)]);
                    $openLibrary = app(OpenLibraryService::class);
                    $olResults = $openLibrary->searchBatch($olQueries, 5);
                    foreach ($olResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        $bestMatch = null;
                        $bestScore = 0.0;
                        foreach ($candidates as $candidate) {
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $pool[$refId]['searchedTitle'];
                            $score   = $llmMeta
                                ? $openAlex->metadataScore($llmMeta, $candidate)
                                : $openAlex->titleSimilarity($title, $candidate['title'] ?? '');
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                            }
                        }
                        if ($bestMatch && $bestScore > 0.3) {
                            $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'open_library', round($bestScore, 3), $openAlex, $db);
                            if ($result) {
                                $results[] = $result;
                                match ($result['status']) {
                                    'newly_resolved' => $newlyResolved++,
                                    'enriched'       => $enrichedExisting++,
                                    default          => $failedToResolve++,
                                };
                                unset($pool[$refId]);
                            }
                        }
                    }
                }
            }

            // ── Wave 6: Web fetch for entries with URLs (Http::pool) ──
            if (!empty($pool)) {
                $webFetch = app(WebFetchService::class);
                $urlItems = [];
                foreach ($pool as $refId => $item) {
                    $url = $webFetch->extractUrl($item['content']);
                    if ($url) {
                        $urlItems[$refId] = [
                            'url'   => $url,
                            'title' => $item['searchedTitle'] ?? 'Web Source',
                        ];
                    }
                }
                if (!empty($urlItems)) {
                    Log::info('Wave 6: Web fetch', ['count' => count($urlItems)]);
                    $fetchResults = $webFetch->fetchAndValidateBatch($urlItems);
                    foreach ($fetchResults as $refId => $text) {
                        if (!$text || !isset($pool[$refId])) {
                            continue;
                        }
                        $item = $pool[$refId];
                        $stubTitle  = $item['searchedTitle'] ?? 'Web Source';
                        $stubAuthor = !empty($item['llmMetadata']['authors']) ? implode('; ', $item['llmMetadata']['authors']) : null;
                        $stubYear   = $item['llmMetadata']['year'] ?? null;
                        $url        = $urlItems[$refId]['url'];

                        $stubBookId = $webFetch->createWebStubWithNodes($db, $stubTitle, $stubAuthor, $stubYear, $text, $url);
                        if ($stubBookId) {
                            $result = $this->resolveWithStub($item, $stubBookId, 'web_fetch', $db);
                            $result['url'] = $url;
                            $results[] = $result;
                            match ($result['status']) {
                                'newly_resolved' => $newlyResolved++,
                                'enriched'       => $enrichedExisting++,
                                default          => $failedToResolve++,
                            };
                            unset($pool[$refId]);
                        }
                    }
                }
            }

            // ── Wave 7: Semantic Scholar (chunked, rate-limited) ──
            if (!empty($pool)) {
                $ssQueries = [];
                foreach ($pool as $refId => $item) {
                    if (!$item['searchedTitle']) {
                        continue;
                    }
                    $ssAuthor = !empty($item['llmMetadata']['authors'][0])
                        ? trim(explode(',', $item['llmMetadata']['authors'][0], 2)[0])
                        : null;
                    $ssQueries[$refId] = ['title' => $item['searchedTitle'], 'author' => $ssAuthor];
                }
                if (!empty($ssQueries)) {
                    Log::info('Wave 7: Semantic Scholar search', ['count' => count($ssQueries)]);
                    $semanticScholar = app(SemanticScholarService::class);
                    $ssResults = $semanticScholar->searchBatch($ssQueries, 5);
                    foreach ($ssResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        $bestMatch = null;
                        $bestScore = 0.0;
                        foreach ($candidates as $candidate) {
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $pool[$refId]['searchedTitle'];
                            $score   = $llmMeta
                                ? $openAlex->metadataScore($llmMeta, $candidate)
                                : $openAlex->titleSimilarity($title, $candidate['title'] ?? '');
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                            }
                        }
                        if ($bestMatch && $bestScore > 0.3) {
                            $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'semantic_scholar', round($bestScore, 3), $openAlex, $db);
                            if ($result) {
                                $results[] = $result;
                                match ($result['status']) {
                                    'newly_resolved' => $newlyResolved++,
                                    'enriched'       => $enrichedExisting++,
                                    default          => $failedToResolve++,
                                };
                                unset($pool[$refId]);
                            }
                        }
                    }
                }
            }

            // ── Wave 8: Brave Search (Http::pool) ──
            if (!empty($pool) && config('services.brave_search.api_key')) {
                $braveQueries = [];
                foreach ($pool as $refId => $item) {
                    if (!$item['searchedTitle']) {
                        continue;
                    }
                    $stubAuthor = !empty($item['llmMetadata']['authors']) ? implode('; ', $item['llmMetadata']['authors']) : null;
                    $braveQueries[$refId] = [
                        'title'  => $item['searchedTitle'],
                        'author' => $stubAuthor,
                        'year'   => $item['llmMetadata']['year'] ?? null,
                    ];
                }
                if (!empty($braveQueries)) {
                    Log::info('Wave 8: Brave Search', ['count' => count($braveQueries)]);
                    $braveSearch = app(BraveSearchService::class);
                    $braveResults = $braveSearch->searchAndFetchBatch($braveQueries, $db);
                    foreach ($braveResults as $refId => $stubBookId) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        $result = $this->resolveWithStub($pool[$refId], $stubBookId, 'brave_search', $db);
                        $results[] = $result;
                        match ($result['status']) {
                            'newly_resolved' => $newlyResolved++,
                            'enriched'       => $enrichedExisting++,
                            default          => $failedToResolve++,
                        };
                        unset($pool[$refId]);
                    }
                }
            }

            // ── Mark remaining as no_match ──
            foreach ($pool as $refId => $item) {
                $db->table('bibliography')
                    ->where('book', $this->bookId)
                    ->where('referenceId', $refId)
                    ->whereNull('foundation_source')
                    ->update([
                        'foundation_source' => 'unknown',
                        'updated_at'        => now(),
                    ]);

                $results[] = [
                    'referenceId'    => $refId,
                    'status'         => 'no_match',
                    'searched_title' => $item['searchedTitle'],
                    'llm_metadata'   => $item['llmMetadata'],
                ];
                $failedToResolve++;
            }

            // Save final results
            $this->saveScanResults($db, $totalEntries, $alreadyLinked, $newlyResolved, $failedToResolve, $enrichedExisting, $results);

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

    /**
     * Resolve a pool entry using a normalised work (OpenAlex/OL/SS shape).
     * Creates or finds a library stub, updates bibliography, returns result array.
     */
    private function resolveWithNormalised(array $poolItem, array $normalised, string $matchMethod, ?float $score, OpenAlexService $openAlex, $db): ?array
    {
        $refId    = $poolItem['referenceId'];
        $isLinked = $poolItem['isLinked'];

        $stubBookId = $openAlex->createOrFindStub($normalised);
        if (!$stubBookId) {
            return [
                'referenceId' => $refId,
                'status'      => 'error',
                'error'       => 'Failed to create library stub',
            ];
        }

        if ($isLinked) {
            // Only set foundation_source — DO NOT modify source_id
            $db->table('bibliography')
                ->where('book', $this->bookId)
                ->where('referenceId', $refId)
                ->update([
                    'foundation_source' => $stubBookId,
                    'updated_at'        => now(),
                ]);

            return [
                'referenceId'        => $refId,
                'status'             => 'enriched',
                'match_method'       => $matchMethod,
                'searched_title'     => $poolItem['searchedTitle'],
                'result_title'       => $normalised['title'],
                'similarity_score'   => $score,
                'openalex_id'        => $normalised['openalex_id'] ?? null,
                'open_library_key'   => $normalised['open_library_key'] ?? null,
                'foundation_book_id' => $stubBookId,
                'is_oa'              => $normalised['is_oa'] ?? null,
                'oa_url'             => $normalised['oa_url'] ?? null,
                'pdf_url'            => $normalised['pdf_url'] ?? null,
                'llm_metadata'       => $poolItem['llmMetadata'],
            ];
        }

        // Unlinked: set both source_id and foundation_source
        $db->table('bibliography')
            ->where('book', $this->bookId)
            ->where('referenceId', $refId)
            ->update([
                'source_id'         => $stubBookId,
                'foundation_source' => $stubBookId,
                'updated_at'        => now(),
            ]);

        return [
            'referenceId'        => $refId,
            'status'             => 'newly_resolved',
            'match_method'       => $matchMethod,
            'searched_title'     => $poolItem['searchedTitle'],
            'result_title'       => $normalised['title'],
            'similarity_score'   => $score,
            'openalex_id'        => $normalised['openalex_id'] ?? null,
            'open_library_key'   => $normalised['open_library_key'] ?? null,
            'foundation_book_id' => $stubBookId,
            'is_oa'              => $normalised['is_oa'] ?? null,
            'oa_url'             => $normalised['oa_url'] ?? null,
            'pdf_url'            => $normalised['pdf_url'] ?? null,
            'llm_metadata'       => $poolItem['llmMetadata'],
        ];
    }

    /**
     * Resolve a pool entry using an already-created stub book ID (web_fetch, brave_search).
     * Updates bibliography and returns result array.
     */
    private function resolveWithStub(array $poolItem, string $stubBookId, string $matchMethod, $db): array
    {
        $refId    = $poolItem['referenceId'];
        $isLinked = $poolItem['isLinked'];

        if ($isLinked) {
            // Only set foundation_source — DO NOT modify source_id
            $db->table('bibliography')
                ->where('book', $this->bookId)
                ->where('referenceId', $refId)
                ->update([
                    'foundation_source' => $stubBookId,
                    'updated_at'        => now(),
                ]);

            return [
                'referenceId'        => $refId,
                'status'             => 'enriched',
                'match_method'       => $matchMethod,
                'searched_title'     => $poolItem['searchedTitle'],
                'result_title'       => $poolItem['searchedTitle'],
                'foundation_book_id' => $stubBookId,
                'llm_metadata'       => $poolItem['llmMetadata'],
            ];
        }

        // Unlinked: set both source_id and foundation_source
        $db->table('bibliography')
            ->where('book', $this->bookId)
            ->where('referenceId', $refId)
            ->update([
                'source_id'         => $stubBookId,
                'foundation_source' => $stubBookId,
                'updated_at'        => now(),
            ]);

        return [
            'referenceId'        => $refId,
            'status'             => 'newly_resolved',
            'match_method'       => $matchMethod,
            'searched_title'     => $poolItem['searchedTitle'],
            'result_title'       => $poolItem['searchedTitle'],
            'foundation_book_id' => $stubBookId,
            'llm_metadata'       => $poolItem['llmMetadata'],
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
     * Save final scan results to the citation_scans table.
     */
    private function saveScanResults($db, int $totalEntries, int $alreadyLinked, int $newlyResolved, int $failedToResolve, int $enrichedExisting, array $results): void
    {
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
    }
}
