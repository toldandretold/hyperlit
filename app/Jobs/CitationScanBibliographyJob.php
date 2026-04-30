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

    private const ACADEMIC_TYPES = [
        'book', 'journal-article', 'book-chapter',
        'conference-paper', 'thesis', 'report',
    ];

    private const CITABLE_TYPES = [
        'book', 'journal-article', 'book-chapter',
        'conference-paper', 'thesis', 'report',
        'web_page', 'chapter',
    ];

    private string $sourceTable = 'bibliography';

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

            // Footnote-only: when bibliography is empty, use footnotes as citation sources
            if ($entries->isEmpty() && !$this->referenceId) {
                $entries = $db->table('footnotes')
                    ->where('book', $this->bookId)
                    ->get()
                    ->map(function ($fn) {
                        $fn->referenceId = $fn->footnoteId;
                        $fn->source_id = $fn->source_id ?? null;
                        return $fn;
                    });
                $this->sourceTable = 'footnotes';
                Log::info('No bibliography — using footnotes as citation sources', [
                    'scan_id' => $this->scanId,
                    'count'   => $entries->count(),
                ]);
            }

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
                $idColumn = $this->sourceTable === 'footnotes' ? 'footnoteId' : 'referenceId';
                $resetQuery = $db->table($this->sourceTable)->where('book', $this->bookId);
                if ($this->referenceId) {
                    $resetQuery->where($idColumn, $this->referenceId);
                }
                $resetData = [
                    'source_id'         => null,
                    'foundation_source' => null,
                    'match_method'      => null,
                    'match_score'       => null,
                    'match_diagnostics' => null,
                    'llm_metadata'      => null,
                    'updated_at'        => now(),
                ];
                if ($this->sourceTable === 'footnotes') {
                    $resetData['is_citation'] = false;
                }
                $resetCount = $resetQuery->update($resetData);

                Log::info('Force mode: cleared matches', [
                    'scan_id'      => $this->scanId,
                    'source_table' => $this->sourceTable,
                    'reset'        => $resetCount,
                ]);

                // Re-fetch entries after reset so in-memory objects reflect nulled columns
                $refetchQuery = $db->table($this->sourceTable)->where('book', $this->bookId);
                if ($this->referenceId) {
                    $refetchQuery->where($idColumn, $this->referenceId);
                }
                $entries = $refetchQuery->get();
                if ($this->sourceTable === 'footnotes') {
                    $entries = $entries->map(function ($fn) {
                        $fn->referenceId = $fn->footnoteId;
                        return $fn;
                    });
                }
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
                    // Use cached LLM metadata if available
                    $cached = $entry->llm_metadata;
                    if (is_string($cached)) {
                        $cached = json_decode($cached, true);
                    }
                    if (!empty($cached) && array_key_exists('type', $cached)) {
                        $llmMetadataMap[$entry->referenceId] = $cached;
                    } else {
                        $toExtract[$entry->referenceId] = $entry->content ?? '';
                    }
                }

                if (!empty($llmMetadataMap)) {
                    Log::info('Skipping LLM extraction for entries with cached metadata', [
                        'scan_id' => $this->scanId,
                        'count'   => count($llmMetadataMap),
                    ]);
                }

                if (!empty($toExtract)) {
                    Log::info('Batch extracting LLM metadata', [
                        'scan_id' => $this->scanId,
                        'count'   => count($toExtract),
                    ]);

                    if ($this->sourceTable === 'footnotes') {
                        // Footnote path: use multi-citation-aware extraction
                        $extractedMulti = $llm->extractFootnoteCitationsBatch($toExtract);
                        foreach ($extractedMulti as $refId => $citationArray) {
                            $primary = $citationArray[0] ?? null;
                            if ($primary) {
                                // Store sub-citations (index 1+) on the primary metadata
                                if (count($citationArray) > 1) {
                                    $primary['sub_citations'] = array_slice($citationArray, 1);
                                }
                                $llmMetadataMap[$refId] = $primary;
                            } else {
                                $llmMetadataMap[$refId] = null;
                            }
                        }
                    } else {
                        // Bibliography path: unchanged
                        $extracted = $llm->extractCitationMetadataBatch($toExtract);
                        $llmMetadataMap = array_merge($llmMetadataMap, $extracted);
                    }

                    // Cache newly extracted metadata on source rows
                    $newlyExtracted = $this->sourceTable === 'footnotes'
                        ? array_intersect_key($llmMetadataMap, $toExtract)
                        : $extracted;
                    foreach ($newlyExtracted as $refId => $metadata) {
                        $this->updateSourceEntry($db, $refId, [
                            'llm_metadata' => json_encode($metadata),
                        ]);
                    }
                }

                // Footnote-only: classify each footnote as citation or not
                if ($this->sourceTable === 'footnotes') {
                    foreach ($llmMetadataMap as $refId => $meta) {
                        if (!$meta) {
                            $this->updateSourceEntry($db, $refId, ['is_citation' => false]);
                            foreach ($needsResolution as $k => $entry) {
                                if ($entry->referenceId === $refId) {
                                    unset($needsResolution[$k]);
                                    break;
                                }
                            }
                            continue;
                        }
                        // A footnote is a citation if the primary OR any sub-citation has a citable type
                        $isCitation = in_array($meta['type'] ?? null, self::CITABLE_TYPES, true);
                        if (!$isCitation && !empty($meta['sub_citations'])) {
                            foreach ($meta['sub_citations'] as $subCit) {
                                if (in_array($subCit['type'] ?? null, self::CITABLE_TYPES, true)) {
                                    $isCitation = true;
                                    break;
                                }
                            }
                        }
                        $this->updateSourceEntry($db, $refId, ['is_citation' => $isCitation]);
                        if (!$isCitation) {
                            // Remove from needsResolution — don't resolve non-citation footnotes
                            foreach ($needsResolution as $k => $entry) {
                                if ($entry->referenceId === $refId) {
                                    unset($needsResolution[$k]);
                                    break;
                                }
                            }
                        }
                    }
                    $needsResolution = array_values($needsResolution);
                    $citationCount = count(array_filter($llmMetadataMap, function ($m) {
                        if (!$m) return false;
                        if (in_array($m['type'] ?? null, self::CITABLE_TYPES, true)) return true;
                        foreach ($m['sub_citations'] ?? [] as $sub) {
                            if (in_array($sub['type'] ?? null, self::CITABLE_TYPES, true)) return true;
                        }
                        return false;
                    }));
                    Log::info("Footnote classification: {$citationCount}/" . count($llmMetadataMap) . " are citations", [
                        'scan_id' => $this->scanId,
                    ]);
                }
            }

            // ── Validate URLs extracted by LLM and flag suspicious ones ──
            foreach ($llmMetadataMap as $refId => &$meta) {
                if (empty($meta['url'])) continue;

                $url = $meta['url'];
                $flags = [];

                // Check for malformed protocol (htts://, htp://, etc.)
                if (preg_match('#^https?://#i', $url) === 0) {
                    if (preg_match('#^[a-z]{2,6}://#i', $url)) {
                        $flags[] = 'malformed_protocol';
                    } else {
                        $flags[] = 'no_protocol';
                    }
                }

                // Check for suspicious domain patterns (double TLDs like google.reports)
                if (preg_match('#^https?://([^/]+)#i', $url, $dm) ||
                    preg_match('#^[a-z]+://([^/]+)#i', $url, $dm)) {
                    $host = $dm[1];
                    $parts = explode('.', $host);
                    if (count($parts) >= 3) {
                        $last = strtolower(end($parts));
                        $knownTlds = ['com','org','net','edu','gov','io','co','uk','au','ca','de','fr','jp','us','info','biz','dev','app','me'];
                        if (!in_array($last, $knownTlds)) {
                            $flags[] = 'suspicious_tld:' . $last;
                        }
                    }
                }

                // DNS check — does the domain even exist?
                $correctedUrl = preg_replace('#^htts://#i', 'https://', $url);
                $correctedUrl = preg_replace('#^htp://#i', 'http://', $correctedUrl);
                $correctedUrl = preg_replace('#^htps://#i', 'https://', $correctedUrl);
                $host = parse_url($correctedUrl, PHP_URL_HOST);
                if ($host && gethostbyname($host) === $host) {
                    $flags[] = 'domain_not_found';
                }

                if (!empty($flags)) {
                    $meta['url_flags'] = $flags;

                    // Update cached metadata with flags
                    $this->updateSourceEntry($db, $refId, [
                        'llm_metadata' => json_encode($meta),
                    ]);
                }
            }
            unset($meta);

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
                    'isAcademic'    => in_array($llmMetadata['type'] ?? null, self::ACADEMIC_TYPES, true)
                                      || ($llmMetadata['type'] ?? null) === null,
                ];
            }

            // Expand pool for multi-citation footnotes: create sub-entries
            $subCitationExpanded = 0;
            foreach (array_keys($pool) as $refId) {
                $subCitations = $pool[$refId]['llmMetadata']['sub_citations'] ?? [];
                if (empty($subCitations)) {
                    continue;
                }
                foreach ($subCitations as $subIndex => $subMeta) {
                    if (!$subMeta || empty($subMeta['title'])) {
                        continue;
                    }
                    $subKey = $refId . '::sub' . ($subIndex + 1);
                    $pool[$subKey] = $pool[$refId]; // clone parent
                    $pool[$subKey]['referenceId']   = $subKey;
                    $pool[$subKey]['parentRefId']   = $refId;
                    $pool[$subKey]['llmMetadata']   = $subMeta;
                    $pool[$subKey]['searchedTitle'] = $subMeta['title'];
                    $pool[$subKey]['doi']           = null;
                    $pool[$subKey]['isAcademic']    = in_array($subMeta['type'] ?? null, self::ACADEMIC_TYPES, true)
                                                      || ($subMeta['type'] ?? null) === null;
                    $subCitationExpanded++;
                }
            }
            if ($subCitationExpanded > 0) {
                Log::info('Pool expanded with sub-citations', [
                    'scan_id'     => $this->scanId,
                    'sub_entries' => $subCitationExpanded,
                    'pool_size'   => count($pool),
                ]);
            }

            $nonAcademicCount = count(array_filter($pool, fn($item) => !$item['isAcademic']));
            Log::info('Wave resolution starting', [
                'scan_id'             => $this->scanId,
                'pool_size'           => count($pool),
                'non_academic_count'  => $nonAcademicCount,
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

            // ── Wave 2a: Local library DOI lookup (DB only — no HTTP) ──
            $doisToLookup = [];
            foreach ($pool as $refId => $item) {
                if ($item['doi']) {
                    $doisToLookup[$refId] = $item['doi'];
                }
            }
            if (!empty($doisToLookup)) {
                Log::info('Wave 2a: Local DOI lookup', ['count' => count($doisToLookup)]);
                $localDoiMatches = $db->table('library')
                    ->whereIn('doi', array_values($doisToLookup))
                    ->get(['book', 'title', 'doi', 'openalex_id', 'open_library_key'])
                    ->keyBy('doi');

                foreach ($doisToLookup as $refId => $doi) {
                    if (!isset($pool[$refId])) continue;
                    $match = $localDoiMatches->get($doi);
                    if ($match) {
                        $item = $pool[$refId];
                        $updateData = $item['isLinked']
                            ? ['foundation_source' => $match->book]
                            : ['source_id' => $match->book, 'foundation_source' => $match->book];

                        $this->updateSourceEntry($db, $refId, $updateData);

                        $results[] = [
                            'referenceId'        => $refId,
                            'status'             => $item['isLinked'] ? 'enriched' : 'newly_resolved',
                            'match_method'       => 'local_doi',
                            'searched_title'     => $item['searchedTitle'],
                            'result_title'       => $match->title,
                            'openalex_id'        => $match->openalex_id,
                            'open_library_key'   => $match->open_library_key,
                            'foundation_book_id' => $match->book,
                            'llm_metadata'       => $item['llmMetadata'],
                        ];
                        $item['isLinked'] ? $enrichedExisting++ : $newlyResolved++;
                        $this->removeRelatedPoolEntries($pool, $refId, $db, $match->book);
                        unset($doisToLookup[$refId]);
                    }
                }

                Log::info('Wave 2a: Local DOI matches', [
                    'found'     => $localDoiMatches->count(),
                    'remaining' => count($doisToLookup),
                ]);
            }

            // ── Wave 2b: DOI lookup on OpenAlex — only DOIs not found locally ──
            if (!empty($doisToLookup)) {
                Log::info('Wave 2b: OpenAlex DOI lookup', ['count' => count($doisToLookup)]);
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
                            $this->removeRelatedPoolEntries($pool, $refId, $db, $result['foundation_book_id'] ?? null);
                        }
                    }
                }
            }

            $nearMisses = []; // refId => best sub-threshold candidate across all waves
            $waveResults = []; // refId => per-wave outcome for diagnostics

            // ── Wave 3: Local library table search (DB queries — no HTTP) ──
            if (!empty($pool)) {
                Log::info('Wave 3: Library table search', ['remaining' => count($pool)]);
                foreach ($pool as $refId => $item) {
                    if (!$item['searchedTitle']) {
                        continue;
                    }
                    $localNearMiss = null;
                    $localMatch = $this->searchLibraryTable($item['searchedTitle'], $item['llmMetadata'], $openAlex, $db, $localNearMiss);
                    if ($localMatch) {
                        $diagJson = !empty($localMatch['diagnostics']) ? json_encode($localMatch['diagnostics']) : null;
                        $updateData = $item['isLinked']
                            ? ['foundation_source' => $localMatch['book'], 'match_method' => 'library', 'match_score' => $localMatch['score'], 'match_diagnostics' => $diagJson]
                            : ['source_id' => $localMatch['book'], 'foundation_source' => $localMatch['book'], 'match_method' => 'library', 'match_score' => $localMatch['score'], 'match_diagnostics' => $diagJson];

                        $this->updateSourceEntry($db, $refId, $updateData);

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
                        $this->removeRelatedPoolEntries($pool, $refId, $db, $localMatch['book']);
                    } elseif ($localNearMiss && $localNearMiss['score'] > ($nearMisses[$refId]['score'] ?? 0.0)) {
                        $nearMisses[$refId] = $localNearMiss;
                    }
                }
            }

            // ── Phase A: Full-title searches (all APIs) ──
            $storedCandidates = [];

            // ── Wave 4: OpenAlex title search (Http::pool) ──
            if (!empty($pool)) {
                $titlesToSearch = [];
                foreach ($pool as $refId => $item) {
                    if ($item['searchedTitle'] && $item['isAcademic']) {
                        $titlesToSearch[$refId] = $item['searchedTitle'];
                    }
                }
                if (!empty($titlesToSearch)) {
                    Log::info('Wave 4: OpenAlex title search', ['count' => count($titlesToSearch)]);
                    $yearFilters = [];
                    foreach ($pool as $refId => $item) {
                        if ($item['searchedTitle'] && !empty($item['llmMetadata']['year'])) {
                            $yearFilters[$refId] = $item['llmMetadata']['original_year'] ?? $item['llmMetadata']['year'];
                        }
                    }
                    $oaResults = $openAlex->searchBatch($titlesToSearch, 5, $yearFilters);
                    foreach ($oaResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        // Store candidates for shortened-title re-scoring
                        $storedCandidates[$refId]['openalex'] = $candidates;

                        $bestMatch = null;
                        $bestScore = 0.0;
                        $bestDiagnostics = null;
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
                            $scoreResult = $llmMeta
                                ? $openAlex->metadataScore($llmMeta, $candidate)
                                : ['score' => $openAlex->titleSimilarity($title, $candidate['title'] ?? '')];
                            $score = $scoreResult['score'];
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                                $bestDiagnostics = $scoreResult;
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
                            if ($this->hasYearMismatchRejection($pool[$refId]['llmMetadata'], $bestMatch, $bestScore)) {
                                Log::info('Wave 4: year mismatch rejection', [
                                    'refId'          => $refId,
                                    'searchedTitle'  => $pool[$refId]['searchedTitle'],
                                    'resultTitle'    => $bestMatch['title'] ?? null,
                                    'score'          => round($bestScore, 3),
                                    'llm_year'       => $pool[$refId]['llmMetadata']['year'] ?? null,
                                    'candidate_year' => $bestMatch['year'] ?? null,
                                ]);
                                $nearMisses[$refId] = [
                                    'score'           => round($bestScore, 3),
                                    'title'           => $bestMatch['title'] ?? null,
                                    'author'          => $bestMatch['author'] ?? null,
                                    'year'            => $bestMatch['year'] ?? null,
                                    'source'          => 'openalex',
                                    'diagnostics'     => $bestDiagnostics,
                                    'rejected_reason' => 'year_mismatch',
                                ];
                            } else {
                                $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'openalex', round($bestScore, 3), $openAlex, $db, $bestDiagnostics);
                                if ($result) {
                                    $results[] = $result;
                                    match ($result['status']) {
                                        'newly_resolved' => $newlyResolved++,
                                        'enriched'       => $enrichedExisting++,
                                        default          => $failedToResolve++,
                                    };
                                    $this->removeRelatedPoolEntries($pool, $refId, $db, $result['foundation_book_id'] ?? null);
                                }
                            }
                        }
                        if (isset($pool[$refId]) && $bestMatch && $bestScore > ($nearMisses[$refId]['score'] ?? 0.0)) {
                            $nearMisses[$refId] = [
                                'score'       => round($bestScore, 3),
                                'title'       => $bestMatch['title'] ?? null,
                                'author'      => $bestMatch['author'] ?? null,
                                'year'        => $bestMatch['year'] ?? null,
                                'source'      => 'openalex',
                                'diagnostics' => $bestDiagnostics,
                            ];
                        }
                        if (isset($pool[$refId])) {
                            $waveResults[$refId]['openalex'] = $bestMatch
                                ? 'best_score:' . round($bestScore, 3)
                                : 'no_candidates';
                        }
                    }
                }

            }

            // ── Wave 5: Open Library search (Http::pool) ──
            if (!empty($pool)) {
                $openLibrary = app(OpenLibraryService::class);

                $olQueries = [];
                foreach ($pool as $refId => $item) {
                    if (!$item['searchedTitle'] || !$item['isAcademic']) {
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
                    $olResults = $openLibrary->searchBatch($olQueries, 5);
                    foreach ($olResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        // Store candidates for shortened-title re-scoring
                        $storedCandidates[$refId]['openlibrary'] = $candidates;

                        $bestMatch = null;
                        $bestScore = 0.0;
                        $bestDiagnostics = null;
                        foreach ($candidates as $candidate) {
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $pool[$refId]['searchedTitle'];
                            $scoreResult = $llmMeta
                                ? $openAlex->metadataScore($llmMeta, $candidate)
                                : ['score' => $openAlex->titleSimilarity($title, $candidate['title'] ?? '')];
                            $score = $scoreResult['score'];
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                                $bestDiagnostics = $scoreResult;
                            }
                        }
                        if ($bestMatch && $bestScore > 0.3) {
                            if ($this->hasYearMismatchRejection($pool[$refId]['llmMetadata'], $bestMatch, $bestScore)) {
                                Log::info('Wave 5: year mismatch rejection', [
                                    'refId'          => $refId,
                                    'searchedTitle'  => $pool[$refId]['searchedTitle'],
                                    'resultTitle'    => $bestMatch['title'] ?? null,
                                    'score'          => round($bestScore, 3),
                                    'llm_year'       => $pool[$refId]['llmMetadata']['year'] ?? null,
                                    'candidate_year' => $bestMatch['year'] ?? null,
                                ]);
                                $nearMisses[$refId] = [
                                    'score'           => round($bestScore, 3),
                                    'title'           => $bestMatch['title'] ?? null,
                                    'author'          => $bestMatch['author'] ?? null,
                                    'year'            => $bestMatch['year'] ?? null,
                                    'source'          => 'open_library',
                                    'diagnostics'     => $bestDiagnostics,
                                    'rejected_reason' => 'year_mismatch',
                                ];
                            } else {
                                $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'open_library', round($bestScore, 3), $openAlex, $db, $bestDiagnostics);
                                if ($result) {
                                    $results[] = $result;
                                    match ($result['status']) {
                                        'newly_resolved' => $newlyResolved++,
                                        'enriched'       => $enrichedExisting++,
                                        default          => $failedToResolve++,
                                    };
                                    $this->removeRelatedPoolEntries($pool, $refId, $db, $result['foundation_book_id'] ?? null);
                                }
                            }
                        }
                        if (isset($pool[$refId]) && $bestMatch && $bestScore > ($nearMisses[$refId]['score'] ?? 0.0)) {
                            $nearMisses[$refId] = [
                                'score'       => round($bestScore, 3),
                                'title'       => $bestMatch['title'] ?? null,
                                'author'      => $bestMatch['author'] ?? null,
                                'year'        => $bestMatch['year'] ?? null,
                                'source'      => 'open_library',
                                'diagnostics' => $bestDiagnostics,
                            ];
                        }
                        if (isset($pool[$refId])) {
                            $waveResults[$refId]['open_library'] = $bestMatch
                                ? 'best_score:' . round($bestScore, 3)
                                : 'no_candidates';
                        }
                    }
                }

            }

            // ── Wave 7: Semantic Scholar search (chunked, rate-limited) ──
            if (!empty($pool)) {
                $semanticScholar = app(SemanticScholarService::class);

                $ssQueries = [];
                foreach ($pool as $refId => $item) {
                    if (!$item['searchedTitle'] || !$item['isAcademic']) {
                        continue;
                    }
                    $ssAuthor = !empty($item['llmMetadata']['authors'][0])
                        ? trim(explode(',', $item['llmMetadata']['authors'][0], 2)[0])
                        : null;
                    $ssQueries[$refId] = ['title' => $item['searchedTitle'], 'author' => $ssAuthor];
                }
                if (!empty($ssQueries)) {
                    Log::info('Wave 7: Semantic Scholar search', ['count' => count($ssQueries)]);
                    $ssResults = $semanticScholar->searchBatch($ssQueries, 5);
                    foreach ($ssResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        // Store candidates for shortened-title re-scoring
                        $storedCandidates[$refId]['semantic_scholar'] = $candidates;

                        $bestMatch = null;
                        $bestScore = 0.0;
                        $bestDiagnostics = null;
                        foreach ($candidates as $candidate) {
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $pool[$refId]['searchedTitle'];
                            $scoreResult = $llmMeta
                                ? $openAlex->metadataScore($llmMeta, $candidate)
                                : ['score' => $openAlex->titleSimilarity($title, $candidate['title'] ?? '')];
                            $score = $scoreResult['score'];
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                                $bestDiagnostics = $scoreResult;
                            }
                        }
                        if ($bestMatch && $bestScore > 0.3) {
                            if ($this->hasYearMismatchRejection($pool[$refId]['llmMetadata'], $bestMatch, $bestScore)) {
                                Log::info('Wave 7: year mismatch rejection', [
                                    'refId'          => $refId,
                                    'searchedTitle'  => $pool[$refId]['searchedTitle'],
                                    'resultTitle'    => $bestMatch['title'] ?? null,
                                    'score'          => round($bestScore, 3),
                                    'llm_year'       => $pool[$refId]['llmMetadata']['year'] ?? null,
                                    'candidate_year' => $bestMatch['year'] ?? null,
                                ]);
                                $nearMisses[$refId] = [
                                    'score'           => round($bestScore, 3),
                                    'title'           => $bestMatch['title'] ?? null,
                                    'author'          => $bestMatch['author'] ?? null,
                                    'year'            => $bestMatch['year'] ?? null,
                                    'source'          => 'semantic_scholar',
                                    'diagnostics'     => $bestDiagnostics,
                                    'rejected_reason' => 'year_mismatch',
                                ];
                            } else {
                                $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'semantic_scholar', round($bestScore, 3), $openAlex, $db, $bestDiagnostics);
                                if ($result) {
                                    $results[] = $result;
                                    match ($result['status']) {
                                        'newly_resolved' => $newlyResolved++,
                                        'enriched'       => $enrichedExisting++,
                                        default          => $failedToResolve++,
                                    };
                                    $this->removeRelatedPoolEntries($pool, $refId, $db, $result['foundation_book_id'] ?? null);
                                }
                            }
                        }
                        if (isset($pool[$refId]) && $bestMatch && $bestScore > ($nearMisses[$refId]['score'] ?? 0.0)) {
                            $nearMisses[$refId] = [
                                'score'       => round($bestScore, 3),
                                'title'       => $bestMatch['title'] ?? null,
                                'author'      => $bestMatch['author'] ?? null,
                                'year'        => $bestMatch['year'] ?? null,
                                'source'      => 'semantic_scholar',
                                'diagnostics' => $bestDiagnostics,
                            ];
                        }
                        if (isset($pool[$refId])) {
                            $waveResults[$refId]['semantic_scholar'] = $bestMatch
                                ? 'best_score:' . round($bestScore, 3)
                                : 'no_candidates';
                        }
                    }
                }
            }

            // ── Phase B: Shortened-title retries ──
            if (!empty($pool)) {
                // Generate shortened titles for entries with subtitle separators
                foreach ($pool as $refId => &$item) {
                    if (!$item['searchedTitle']) {
                        continue;
                    }
                    if (preg_match('/^(.{10,}?)\s*[:\x{2013}\x{2014}]\s/u', $item['searchedTitle'], $m)) {
                        $shortened = trim($m[1]);
                        if ($shortened !== $item['searchedTitle'] && strlen($shortened) >= 10) {
                            $item['shortenedTitle'] = $shortened;
                        }
                    }
                }
                unset($item);

                // Re-score stored candidates from Phase A using shortened titles
                foreach ($pool as $refId => $item) {
                    if (empty($item['shortenedTitle']) || empty($storedCandidates[$refId])) {
                        continue;
                    }
                    $shortened = $item['shortenedTitle'];
                    $bestMatch = null;
                    $bestScore = 0.0;
                    $bestSource = null;
                    $bestDiagnostics = null;

                    foreach ($storedCandidates[$refId] as $source => $candidates) {
                        foreach ($candidates as $candidate) {
                            if ($source === 'openalex' && !$openAlex->isCitableWork($candidate)) {
                                continue;
                            }
                            $scoreMeta = $item['llmMetadata'];
                            if ($scoreMeta) {
                                $scoreMeta['title'] = $shortened;
                            }
                            $scoreResult = $scoreMeta
                                ? $openAlex->metadataScore($scoreMeta, $candidate)
                                : ['score' => $openAlex->titleSimilarity($shortened, $candidate['title'] ?? '')];
                            $score = $scoreResult['score'];
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                                $bestSource = $source;
                                $bestDiagnostics = $scoreResult;
                            }
                        }
                    }

                    $sourceToMethod = [
                        'openalex'         => 'openalex',
                        'openlibrary'      => 'open_library',
                        'semantic_scholar' => 'semantic_scholar',
                    ];

                    if ($bestMatch && $bestScore > 0.5 && $this->hasAuthorOrYearConfirmation($item['llmMetadata'], $bestMatch)) {
                        $matchMethod = $sourceToMethod[$bestSource] ?? $bestSource;
                        Log::info('Shortened-title re-score: matched from stored candidates', [
                            'refId'          => $refId,
                            'shortenedTitle' => $shortened,
                            'resultTitle'    => $bestMatch['title'] ?? null,
                            'score'          => $bestScore,
                            'source'         => $bestSource,
                        ]);
                        $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, $matchMethod, round($bestScore, 3), $openAlex, $db, $bestDiagnostics);
                        if ($result) {
                            $results[] = $result;
                            match ($result['status']) {
                                'newly_resolved' => $newlyResolved++,
                                'enriched'       => $enrichedExisting++,
                                default          => $failedToResolve++,
                            };
                            $this->removeRelatedPoolEntries($pool, $refId, $db, $result['foundation_book_id'] ?? null);
                        }
                    }
                    if (isset($pool[$refId]) && $bestMatch && $bestScore > ($nearMisses[$refId]['score'] ?? 0.0)) {
                        $nearMisses[$refId] = [
                            'score'       => round($bestScore, 3),
                            'title'       => $bestMatch['title'] ?? null,
                            'author'      => $bestMatch['author'] ?? null,
                            'year'        => $bestMatch['year'] ?? null,
                            'source'      => $sourceToMethod[$bestSource] ?? $bestSource,
                            'diagnostics' => $bestDiagnostics,
                        ];
                    }
                }

                // API calls for entries still unresolved after re-scoring

                // ── Wave 4b: OpenAlex retry with shortened titles ──
                $retryTitles = [];
                $retryYearFilters = [];
                foreach ($pool as $refId => $item) {
                    if (empty($item['shortenedTitle']) || !$item['isAcademic']) {
                        continue;
                    }
                    $retryTitles[$refId] = $item['shortenedTitle'];
                    if (!empty($item['llmMetadata']['year'])) {
                        $retryYearFilters[$refId] = $item['llmMetadata']['year'];
                    }
                }
                if (!empty($retryTitles)) {
                    Log::info('Wave 4b: OpenAlex retry with shortened titles', ['count' => count($retryTitles)]);
                    $oaRetryResults = $openAlex->searchBatch($retryTitles, 5, $retryYearFilters);
                    foreach ($oaRetryResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        $bestMatch = null;
                        $bestScore = 0.0;
                        $bestDiagnostics = null;
                        foreach ($candidates as $candidate) {
                            if (!$openAlex->isCitableWork($candidate)) {
                                continue;
                            }
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $retryTitles[$refId];
                            $scoreMeta = $llmMeta;
                            if ($scoreMeta) {
                                $scoreMeta['title'] = $title;
                            }
                            $scoreResult = $scoreMeta
                                ? $openAlex->metadataScore($scoreMeta, $candidate)
                                : ['score' => $openAlex->titleSimilarity($title, $candidate['title'] ?? '')];
                            $score = $scoreResult['score'];
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                                $bestDiagnostics = $scoreResult;
                            }
                        }
                        if ($bestMatch && $bestScore > 0.5 && $this->hasAuthorOrYearConfirmation($pool[$refId]['llmMetadata'], $bestMatch)) {
                            Log::info('Wave 4b: matched with shortened title', [
                                'refId'          => $refId,
                                'shortenedTitle' => $retryTitles[$refId],
                                'resultTitle'    => $bestMatch['title'] ?? null,
                                'score'          => $bestScore,
                            ]);
                            $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'openalex', round($bestScore, 3), $openAlex, $db, $bestDiagnostics);
                            if ($result) {
                                $results[] = $result;
                                match ($result['status']) {
                                    'newly_resolved' => $newlyResolved++,
                                    'enriched'       => $enrichedExisting++,
                                    default          => $failedToResolve++,
                                };
                                $this->removeRelatedPoolEntries($pool, $refId, $db, $result['foundation_book_id'] ?? null);
                            }
                        }
                        if (isset($pool[$refId]) && $bestMatch && $bestScore > ($nearMisses[$refId]['score'] ?? 0.0)) {
                            $nearMisses[$refId] = [
                                'score'       => round($bestScore, 3),
                                'title'       => $bestMatch['title'] ?? null,
                                'author'      => $bestMatch['author'] ?? null,
                                'year'        => $bestMatch['year'] ?? null,
                                'source'      => 'openalex',
                                'diagnostics' => $bestDiagnostics,
                            ];
                        }
                        if (isset($pool[$refId])) {
                            $waveResults[$refId]['openalex_short'] = $bestMatch
                                ? 'best_score:' . round($bestScore, 3)
                                : 'no_candidates';
                        }
                    }
                }

                // ── Wave 5b: Open Library retry with shortened titles ──
                if (!isset($openLibrary)) {
                    $openLibrary = app(OpenLibraryService::class);
                }
                $olRetryQueries = [];
                foreach ($pool as $refId => $item) {
                    if (empty($item['shortenedTitle']) || !$item['isAcademic']) {
                        continue;
                    }
                    $olAuthor = null;
                    if (!empty($item['llmMetadata']['authors'][0])) {
                        $parts = explode(',', $item['llmMetadata']['authors'][0], 2);
                        $olAuthor = trim($parts[0]);
                    }
                    $olRetryQueries[$refId] = ['title' => $item['shortenedTitle'], 'author' => $olAuthor];
                }
                if (!empty($olRetryQueries)) {
                    Log::info('Wave 5b: Open Library retry with shortened titles', ['count' => count($olRetryQueries)]);
                    $olRetryResults = $openLibrary->searchBatch($olRetryQueries, 5);
                    foreach ($olRetryResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        $bestMatch = null;
                        $bestScore = 0.0;
                        $bestDiagnostics = null;
                        foreach ($candidates as $candidate) {
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $pool[$refId]['shortenedTitle'];
                            $scoreMeta = $llmMeta;
                            if ($scoreMeta) {
                                $scoreMeta['title'] = $title;
                            }
                            $scoreResult = $scoreMeta
                                ? $openAlex->metadataScore($scoreMeta, $candidate)
                                : ['score' => $openAlex->titleSimilarity($title, $candidate['title'] ?? '')];
                            $score = $scoreResult['score'];
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                                $bestDiagnostics = $scoreResult;
                            }
                        }
                        if ($bestMatch && $bestScore > 0.5 && $this->hasAuthorOrYearConfirmation($pool[$refId]['llmMetadata'], $bestMatch)) {
                            Log::info('Wave 5b: matched with shortened title', [
                                'refId'          => $refId,
                                'shortenedTitle' => $pool[$refId]['shortenedTitle'],
                                'resultTitle'    => $bestMatch['title'] ?? null,
                                'score'          => $bestScore,
                            ]);
                            $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'open_library', round($bestScore, 3), $openAlex, $db, $bestDiagnostics);
                            if ($result) {
                                $results[] = $result;
                                match ($result['status']) {
                                    'newly_resolved' => $newlyResolved++,
                                    'enriched'       => $enrichedExisting++,
                                    default          => $failedToResolve++,
                                };
                                $this->removeRelatedPoolEntries($pool, $refId, $db, $result['foundation_book_id'] ?? null);
                            }
                        }
                        if (isset($pool[$refId]) && $bestMatch && $bestScore > ($nearMisses[$refId]['score'] ?? 0.0)) {
                            $nearMisses[$refId] = [
                                'score'       => round($bestScore, 3),
                                'title'       => $bestMatch['title'] ?? null,
                                'author'      => $bestMatch['author'] ?? null,
                                'year'        => $bestMatch['year'] ?? null,
                                'source'      => 'open_library',
                                'diagnostics' => $bestDiagnostics,
                            ];
                        }
                        if (isset($pool[$refId])) {
                            $waveResults[$refId]['open_library_short'] = $bestMatch
                                ? 'best_score:' . round($bestScore, 3)
                                : 'no_candidates';
                        }
                    }
                }

                // ── Wave 7b: Semantic Scholar retry with shortened titles ──
                if (!isset($semanticScholar)) {
                    $semanticScholar = app(SemanticScholarService::class);
                }
                $ssRetryQueries = [];
                foreach ($pool as $refId => $item) {
                    if (empty($item['shortenedTitle']) || !$item['isAcademic']) {
                        continue;
                    }
                    $ssAuthor = !empty($item['llmMetadata']['authors'][0])
                        ? trim(explode(',', $item['llmMetadata']['authors'][0], 2)[0])
                        : null;
                    $ssRetryQueries[$refId] = ['title' => $item['shortenedTitle'], 'author' => $ssAuthor];
                }
                if (!empty($ssRetryQueries)) {
                    Log::info('Wave 7b: Semantic Scholar retry with shortened titles', ['count' => count($ssRetryQueries)]);
                    $ssRetryResults = $semanticScholar->searchBatch($ssRetryQueries, 5);
                    foreach ($ssRetryResults as $refId => $candidates) {
                        if (!isset($pool[$refId])) {
                            continue;
                        }
                        $bestMatch = null;
                        $bestScore = 0.0;
                        $bestDiagnostics = null;
                        foreach ($candidates as $candidate) {
                            $llmMeta = $pool[$refId]['llmMetadata'];
                            $title   = $pool[$refId]['shortenedTitle'];
                            $scoreMeta = $llmMeta;
                            if ($scoreMeta) {
                                $scoreMeta['title'] = $title;
                            }
                            $scoreResult = $scoreMeta
                                ? $openAlex->metadataScore($scoreMeta, $candidate)
                                : ['score' => $openAlex->titleSimilarity($title, $candidate['title'] ?? '')];
                            $score = $scoreResult['score'];
                            if ($score > $bestScore) {
                                $bestScore = $score;
                                $bestMatch = $candidate;
                                $bestDiagnostics = $scoreResult;
                            }
                        }
                        if ($bestMatch && $bestScore > 0.5 && $this->hasAuthorOrYearConfirmation($pool[$refId]['llmMetadata'], $bestMatch)) {
                            Log::info('Wave 7b: matched with shortened title', [
                                'refId'          => $refId,
                                'shortenedTitle' => $pool[$refId]['shortenedTitle'],
                                'resultTitle'    => $bestMatch['title'] ?? null,
                                'score'          => $bestScore,
                            ]);
                            $result = $this->resolveWithNormalised($pool[$refId], $bestMatch, 'semantic_scholar', round($bestScore, 3), $openAlex, $db, $bestDiagnostics);
                            if ($result) {
                                $results[] = $result;
                                match ($result['status']) {
                                    'newly_resolved' => $newlyResolved++,
                                    'enriched'       => $enrichedExisting++,
                                    default          => $failedToResolve++,
                                };
                                $this->removeRelatedPoolEntries($pool, $refId, $db, $result['foundation_book_id'] ?? null);
                            }
                        }
                        if (isset($pool[$refId]) && $bestMatch && $bestScore > ($nearMisses[$refId]['score'] ?? 0.0)) {
                            $nearMisses[$refId] = [
                                'score'       => round($bestScore, 3),
                                'title'       => $bestMatch['title'] ?? null,
                                'author'      => $bestMatch['author'] ?? null,
                                'year'        => $bestMatch['year'] ?? null,
                                'source'      => 'semantic_scholar',
                                'diagnostics' => $bestDiagnostics,
                            ];
                        }
                        if (isset($pool[$refId])) {
                            $waveResults[$refId]['semantic_scholar_short'] = $bestMatch
                                ? 'best_score:' . round($bestScore, 3)
                                : 'no_candidates';
                        }
                    }
                }
            }

            // ── Phase C: Remaining waves ──

            // ── Wave 6: Web fetch for entries with URLs (Http::pool) ──
            if (!empty($pool)) {
                $webFetch = app(WebFetchService::class);
                $urlItems = [];
                $llmUrlEntries = [];
                foreach ($pool as $refId => $item) {
                    $url = $webFetch->extractUrl($item['content']);

                    // Fallback: use LLM-extracted URL (with protocol typo fix)
                    if (!$url && !empty($item['llmMetadata']['url'])) {
                        $llmUrl = $item['llmMetadata']['url'];
                        $llmUrl = preg_replace('#^htts://#i', 'https://', $llmUrl);
                        $llmUrl = preg_replace('#^htp://#i', 'http://', $llmUrl);
                        $llmUrl = preg_replace('#^htps://#i', 'https://', $llmUrl);
                        if (preg_match('#^https?://#i', $llmUrl)) {
                            $url = $llmUrl;
                            $llmUrlEntries[$refId] = true;
                        }
                    }

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
                            $result['url_flags'] = $item['llmMetadata']['url_flags'] ?? null;
                            $results[] = $result;
                            match ($result['status']) {
                                'newly_resolved' => $newlyResolved++,
                                'enriched'       => $enrichedExisting++,
                                default          => $failedToResolve++,
                            };
                            $this->removeRelatedPoolEntries($pool, $refId, $db, $stubBookId);
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
                    $braveTitle = $item['searchedTitle'];
                    $stubAuthor = !empty($item['llmMetadata']['authors']) ? implode('; ', $item['llmMetadata']['authors']) : null;
                    $braveQueries[$refId] = [
                        'title'  => $braveTitle,
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
                        $result['url_flags'] = $pool[$refId]['llmMetadata']['url_flags'] ?? null;
                        $results[] = $result;
                        match ($result['status']) {
                            'newly_resolved' => $newlyResolved++,
                            'enriched'       => $enrichedExisting++,
                            default          => $failedToResolve++,
                        };
                        $this->removeRelatedPoolEntries($pool, $refId, $db, $stubBookId);
                    }
                }
            }

            // ── Mark remaining as no_match ──
            foreach ($pool as $refId => $item) {
                // Skip sub-citation entries — only mark the parent as no_match
                if (str_contains($refId, '::sub')) {
                    continue;
                }
                $nearMiss = $nearMisses[$refId] ?? null;

                // If no near-miss candidate was found, create diagnostic from wave results
                if (!$nearMiss && !empty($waveResults[$refId])) {
                    $nearMiss = [
                        'score'       => 0.0,
                        'title'       => null,
                        'source'      => 'none',
                        'diagnostics' => ['wave_results' => $waveResults[$refId]],
                    ];
                } elseif (!$nearMiss) {
                    $nearMiss = [
                        'score'       => 0.0,
                        'title'       => null,
                        'source'      => 'none',
                        'diagnostics' => ['reason' => $item['searchedTitle'] ? 'no_candidates_all_waves' : 'no_searchable_title'],
                    ];
                }

                $idColumn = $this->sourceTable === 'footnotes' ? 'footnoteId' : 'referenceId';
                $db->table($this->sourceTable)
                    ->where('book', $this->bookId)
                    ->where($idColumn, $refId)
                    ->whereNull('foundation_source')
                    ->update([
                        'foundation_source'  => 'unknown',
                        'match_diagnostics'  => json_encode($nearMiss),
                        'updated_at'         => now(),
                    ]);

                $results[] = [
                    'referenceId'    => $refId,
                    'status'         => 'no_match',
                    'searched_title' => $item['searchedTitle'],
                    'llm_metadata'   => $item['llmMetadata'],
                    'near_miss'      => $nearMiss,
                    'url_flags'      => $item['llmMetadata']['url_flags'] ?? null,
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
    private function resolveWithNormalised(array $poolItem, array $normalised, string $matchMethod, ?float $score, OpenAlexService $openAlex, $db, ?array $matchDiagnostics = null): ?array
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

        // Enrich stub title with LLM metadata if more complete
        $llmTitle = $poolItem['llmMetadata']['title'] ?? null;
        $normalisedTitle = $normalised['title'] ?? '';
        if ($llmTitle && mb_strlen($llmTitle) > mb_strlen($normalisedTitle) && $normalisedTitle !== '') {
            if (mb_stripos($llmTitle, $normalisedTitle) !== false) {
                $db->table('library')
                    ->where('book', $stubBookId)
                    ->update(['title' => $llmTitle, 'updated_at' => now()]);
                Log::info('Enriched stub title with LLM metadata', [
                    'stubBookId' => $stubBookId,
                    'oldTitle'   => $normalisedTitle,
                    'newTitle'   => $llmTitle,
                ]);
            }
        }

        if ($isLinked) {
            // Only set foundation_source — DO NOT modify source_id
            $this->updateSourceEntry($db, $refId, [
                'foundation_source'  => $stubBookId,
                'match_method'       => $matchMethod,
                'match_score'        => $score,
                'match_diagnostics'  => $matchDiagnostics ? json_encode($matchDiagnostics) : null,
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
        $this->updateSourceEntry($db, $refId, [
            'source_id'          => $stubBookId,
            'foundation_source'  => $stubBookId,
            'match_method'       => $matchMethod,
            'match_score'        => $score,
            'match_diagnostics'  => $matchDiagnostics ? json_encode($matchDiagnostics) : null,
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
            $this->updateSourceEntry($db, $refId, [
                'foundation_source' => $stubBookId,
                'match_method'      => $matchMethod,
                'match_score'       => null,
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
        $this->updateSourceEntry($db, $refId, [
            'source_id'         => $stubBookId,
            'foundation_source' => $stubBookId,
            'match_method'      => $matchMethod,
            'match_score'       => null,
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
     * Write back to the correct source table (bibliography or footnotes).
     */
    private function updateSourceEntry($db, string $refId, array $data): void
    {
        $idColumn = $this->sourceTable === 'footnotes' ? 'footnoteId' : 'referenceId';
        $db->table($this->sourceTable)
            ->where('book', $this->bookId)
            ->where($idColumn, $refId)
            ->update(array_merge($data, ['updated_at' => now()]));
    }

    /**
     * Search the local library table for a verified matching work.
     * Only returns stubs that have been verified (have openalex_id or open_library_key).
     * Returns ['book' => uuid, 'title' => ..., 'score' => float] or null.
     */
    private function searchLibraryTable(string $title, ?array $llmMetadata, OpenAlexService $openAlex, $db, ?array &$nearMiss = null): ?array
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
        $bestDiagnostics = null;

        foreach ($candidates as $row) {
            $candidate = [
                'title'  => $row->title,
                'author' => $row->author,
                'year'   => $row->year,
            ];

            $scoreResult = $llmMetadata
                ? $openAlex->metadataScore($llmMetadata, $candidate)
                : ['score' => $openAlex->titleSimilarity($title, $row->title ?? '')];
            $score = $scoreResult['score'];

            if ($score > $bestScore) {
                $bestScore = $score;
                $bestMatch = $row;
                $bestDiagnostics = $scoreResult;
            }
        }

        if ($bestMatch && $bestScore >= 0.5) {
            return [
                'book'             => $bestMatch->book,
                'title'            => $bestMatch->title,
                'score'            => round($bestScore, 3),
                'diagnostics'      => $bestDiagnostics,
                'openalex_id'      => $bestMatch->openalex_id,
                'open_library_key' => $bestMatch->open_library_key,
            ];
        }

        // Below threshold — populate near-miss for caller
        if ($bestMatch) {
            $nearMiss = [
                'score'       => round($bestScore, 3),
                'title'       => $bestMatch->title,
                'author'      => $bestMatch->author,
                'year'        => $bestMatch->year,
                'source'      => 'library',
                'diagnostics' => $bestDiagnostics,
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

    /**
     * Check whether a candidate should be rejected due to a large year gap.
     * Applied to full-title waves (4, 5, 7) where the threshold is 0.3 and
     * year weight alone isn't enough to prevent false matches.
     *
     * Returns true if the match should be REJECTED.
     */
    private function hasYearMismatchRejection(?array $llmMeta, array $candidate, float $score): bool
    {
        if (!$llmMeta || $score >= 0.6) {
            return false; // High-scoring matches pass through (editions/reprints)
        }

        $candidateYear = isset($candidate['year']) ? (int) $candidate['year'] : null;
        if ($candidateYear === null) {
            return false;
        }

        // Check both year and original_year — use whichever is closest
        $llmYears = array_filter([
            isset($llmMeta['year']) ? (int) $llmMeta['year'] : null,
            isset($llmMeta['original_year']) ? (int) $llmMeta['original_year'] : null,
        ], fn($y) => $y !== null);

        if (empty($llmYears)) {
            return false;
        }

        $closestGap = min(array_map(fn($y) => abs($y - $candidateYear), $llmYears));

        return $closestGap > 5;
    }

    /**
     * Remove all related pool entries (parent + sub-citations) when any citation resolves.
     * When a sub-citation resolves, also writes foundation_source back to the parent footnote.
     */
    private function removeRelatedPoolEntries(array &$pool, string $resolvedRefId, $db, ?string $stubBookId = null): void
    {
        $parentRefId = $pool[$resolvedRefId]['parentRefId'] ?? null;
        $baseRefId = $parentRefId ?? $resolvedRefId;

        // If a sub-citation resolved, write foundation_source to the parent footnote (only if not already set)
        if ($parentRefId && $stubBookId && $this->sourceTable === 'footnotes') {
            $parent = $db->table('footnotes')
                ->where('book', $this->bookId)
                ->where('footnoteId', $parentRefId)
                ->first(['foundation_source']);
            if ($parent && empty($parent->foundation_source)) {
                $this->updateSourceEntry($db, $parentRefId, [
                    'foundation_source' => $stubBookId,
                ]);
            }
        }

        // Remove the resolved entry itself
        unset($pool[$resolvedRefId]);

        // Remove all related entries (parent and all its subs)
        $keysToRemove = [];
        foreach ($pool as $key => $item) {
            // This is a sub of the same parent
            if (($item['parentRefId'] ?? null) === $baseRefId) {
                $keysToRemove[] = $key;
            }
            // This is the parent itself
            if ($key === $baseRefId) {
                $keysToRemove[] = $key;
            }
        }
        foreach ($keysToRemove as $key) {
            unset($pool[$key]);
        }
    }

    /**
     * Check whether a candidate has at least author OR year confirmation against LLM metadata.
     * Used as an extra guard for shortened-title "b" waves to prevent false positives.
     */
    private function hasAuthorOrYearConfirmation(?array $llmMeta, array $candidate): bool
    {
        if (!$llmMeta) {
            return false;
        }

        // Year check: exact or ±1
        $llmYear = $llmMeta['year'] ?? null;
        $candidateYear = $candidate['year'] ?? null;
        if ($llmYear !== null && $candidateYear !== null) {
            if (abs((int) $llmYear - (int) $candidateYear) <= 1) {
                return true;
            }
        }

        // Author check: any LLM author surname found as a whole word in candidate author
        $llmAuthors = $llmMeta['authors'] ?? [];
        $candidateAuthor = $candidate['author'] ?? '';
        if (!empty($llmAuthors) && !empty($candidateAuthor)) {
            $candidateAuthorLower = mb_strtolower($candidateAuthor);
            foreach ($llmAuthors as $author) {
                $parts = explode(',', $author, 2);
                $surname = mb_strtolower(trim($parts[0]));
                if ($surname && strlen($surname) >= 2) {
                    // Word-boundary match — prevents "Smith" matching "Blacksmith"
                    if (preg_match('/\b' . preg_quote($surname, '/') . '\b/iu', $candidateAuthorLower)) {
                        return true;
                    }
                }
            }
        }

        Log::debug('Shortened-title wave: no author/year confirmation', [
            'llm_authors' => $llmAuthors,
            'llm_year' => $llmYear,
            'candidate_author' => $candidateAuthor,
            'candidate_year' => $candidateYear,
        ]);

        return false;
    }
}
