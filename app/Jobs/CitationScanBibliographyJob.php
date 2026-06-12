<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use App\Models\PgLibrary;
use App\Services\CanonicalSourceMatcher;
use App\Services\ContentFetchService;
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

    /**
     * Citation types that REFER rather than fully cite — each has dedicated
     * routing instead of the external resolution waves: short-form/ibid →
     * antecedent matcher; pointer → bibliography matcher; legislation/case-law
     * → counted but never externally resolved (no scholarly-database identity).
     */
    private const REFERENCE_STYLE_TYPES = ['short-form', 'ibid', 'pointer', 'legislation', 'case-law'];

    /**
     * Identifier-backed match methods → canonical foundation_source. Only these
     * get canonical_source rows: web_fetch / brave_search stubs have no external
     * identity, and a wrong canonical is worse than a missing one.
     */
    private const CANONICAL_FOUNDATION_BY_METHOD = [
        'doi'              => 'openalex_ingest',
        'openalex'         => 'openalex_ingest',
        'open_library'     => 'open_library_ingest',
        'semantic_scholar' => 'semantic_scholar_ingest',
    ];

    private string $sourceTable = 'bibliography';

    public function __construct(
        private string $scanId,
        private string $bookId,
        private ?string $referenceId = null,
        private bool $force = false,
        private ?string $sourceTableOverride = null, // 'footnotes' = scan footnotes even when a bibliography exists
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

            // Footnote pass requested explicitly (books with BOTH a bibliography
            // and citation-bearing footnotes — e.g. footnotes that are author-date
            // POINTERS into the bibliography). Without the override, footnotes are
            // only scanned as a fallback when the bibliography is empty.
            if ($this->sourceTableOverride === 'footnotes' && !$this->referenceId) {
                $entries = collect();
            } else {
                // Fetch bibliography entries (optionally filtered to a single referenceId)
                $query = $db->table('bibliography')->where('book', $this->bookId);
                if ($this->referenceId) {
                    $query->where('referenceId', $this->referenceId);
                }
                $entries = $query->get();
            }

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
            $shortFormMap    = []; // short-form footnoteId → antecedent footnoteId

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
                        // A footnote is a citation if the primary OR any sub-citation has a citable type.
                        // Reference-style types are citations too, each with its own routing:
                        //   short-form/ibid → antecedent matcher (earlier footnote in this document)
                        //   pointer         → bibliography matcher (surname+year → the book's own bibliography)
                        //   legislation/case-law → counted as citations; NEVER resolved externally
                        //                          (an instrument string like "Art. 5(3)(a) ISD" is not
                        //                          an OpenAlex query — mis-match risk)
                        $isCitation = in_array($meta['type'] ?? null, self::CITABLE_TYPES, true)
                            || in_array($meta['type'] ?? null, self::REFERENCE_STYLE_TYPES, true);
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

                    // Link short-form / ibid footnotes to their antecedent full
                    // citations (deterministic; LLM only to pick among multiple
                    // known candidates). They are REMOVED from independent
                    // resolution either way — resolving "Hart, Justice" alone
                    // matches the wrong work.
                    $shortFormMap = $this->matchShortFormAntecedents(
                        $db,
                        $needsResolution,
                        fn(array $items) => $llm->disambiguateShortFormBatch($items),
                    );

                    // Author-date POINTER footnotes ("Chapman (2009), p. 6") resolve
                    // against the book's OWN bibliography — the full reference lives
                    // there (already externally resolved by the bibliography scan).
                    // Resolving a title-less author-date externally would mis-match.
                    $this->matchBibliographyPointers($db, $needsResolution);

                    // Legislation / case-law citations are COUNTED (claims anchor on
                    // their markers) but never sent to the external waves — an
                    // instrument string is not a scholarly-database query.
                    $legalCount = $this->excludeLegalFromResolution($db, $needsResolution);

                    // Document-level footnote-style profile: the per-footnote type
                    // distribution tells us HOW this text cites (author-date
                    // pointers / self-contained / legal / archival) — logged and
                    // emitted so the report and future routing can use it.
                    $styleCounts = [];
                    foreach ($llmMetadataMap as $meta) {
                        if ($meta) {
                            $t = $meta['type'] ?? 'unknown';
                            $styleCounts[$t] = ($styleCounts[$t] ?? 0) + 1;
                        }
                    }
                    arsort($styleCounts);
                    Log::info('Footnote style profile', [
                        'book' => $this->bookId, 'types' => $styleCounts,
                        'legal_citations' => $legalCount,
                    ]);
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

                // Flag a genuinely-bogus TLD (e.g. an LLM-fabricated "google.reports").
                // The TLD is the LAST segment — validate it against real TLDs, NOT a
                // tiny allow-list. Country-code TLDs (.in/.cn/.de/.br …) and gov SLDs
                // like gov.in are legitimate and must NOT be flagged. The DNS check
                // below is the stronger fabrication signal; this only catches an
                // outright invalid TLD string.
                if (preg_match('#^https?://([^/]+)#i', $url, $dm) ||
                    preg_match('#^[a-z]+://([^/]+)#i', $url, $dm)) {
                    $host = $dm[1];
                    $parts = explode('.', $host);
                    if (count($parts) >= 2) {
                        $last = strtolower(end($parts));
                        if (!$this->isValidTld($last)) {
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
                    ->get(['book', 'title', 'doi', 'openalex_id', 'open_library_key', 'canonical_source_id'])
                    ->keyBy('doi');

                foreach ($doisToLookup as $refId => $doi) {
                    if (!isset($pool[$refId])) continue;
                    $match = $localDoiMatches->get($doi);
                    if ($match) {
                        $item = $pool[$refId];
                        $updateData = $item['isLinked']
                            ? ['foundation_source' => $match->book]
                            : ['source_id' => $match->book, 'foundation_source' => $match->book];
                        // Carry the matched row's existing canonical link through
                        $updateData = array_merge($updateData, $this->canonicalColumnFor($match->canonical_source_id));

                        $this->updateSourceEntry($db, $refId, $updateData);

                        $results[] = [
                            'referenceId'         => $refId,
                            'status'              => $item['isLinked'] ? 'enriched' : 'newly_resolved',
                            'match_method'        => 'local_doi',
                            'searched_title'      => $item['searchedTitle'],
                            'result_title'        => $match->title,
                            'openalex_id'         => $match->openalex_id,
                            'open_library_key'    => $match->open_library_key,
                            'foundation_book_id'  => $match->book,
                            'canonical_source_id' => $match->canonical_source_id,
                            'llm_metadata'        => $item['llmMetadata'],
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
                        // Carry the matched row's existing canonical link through
                        $updateData = array_merge($updateData, $this->canonicalColumnFor($localMatch['canonical_source_id'] ?? null));

                        $this->updateSourceEntry($db, $refId, $updateData);

                        $results[] = [
                            'referenceId'         => $refId,
                            'status'              => $item['isLinked'] ? 'enriched' : 'newly_resolved',
                            'match_method'        => 'library',
                            'searched_title'      => $item['searchedTitle'],
                            'result_title'        => $localMatch['title'],
                            'similarity_score'    => $localMatch['score'],
                            'openalex_id'         => $localMatch['openalex_id'] ?? null,
                            'open_library_key'    => $localMatch['open_library_key'] ?? null,
                            'foundation_book_id'  => $localMatch['book'],
                            'canonical_source_id' => $localMatch['canonical_source_id'] ?? null,
                            'llm_metadata'        => $item['llmMetadata'],
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
                        if ($bestMatch && $bestScore > 0.3 && $this->hasTitleConfidence($bestDiagnostics, $bestScore)) {
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
                        if ($bestMatch && $bestScore > 0.3 && $this->hasTitleConfidence($bestDiagnostics, $bestScore)) {
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
                        if ($bestMatch && $bestScore > 0.3 && $this->hasTitleConfidence($bestDiagnostics, $bestScore)) {
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

                    if ($bestMatch && $bestScore > 0.5 && $this->hasTitleConfidence($bestDiagnostics, $bestScore) && $this->hasAuthorOrYearConfirmation($item['llmMetadata'], $bestMatch)) {
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
                        if ($bestMatch && $bestScore > 0.5 && $this->hasTitleConfidence($bestDiagnostics, $bestScore) && $this->hasAuthorOrYearConfirmation($pool[$refId]['llmMetadata'], $bestMatch)) {
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
                        if ($bestMatch && $bestScore > 0.5 && $this->hasTitleConfidence($bestDiagnostics, $bestScore) && $this->hasAuthorOrYearConfirmation($pool[$refId]['llmMetadata'], $bestMatch)) {
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
                        if ($bestMatch && $bestScore > 0.5 && $this->hasTitleConfidence($bestDiagnostics, $bestScore) && $this->hasAuthorOrYearConfirmation($pool[$refId]['llmMetadata'], $bestMatch)) {
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

                        // NB: web-source browser-fetch + verification is NOT done here —
                        // it's slow (a browser launch per source) and would stall the
                        // bibliography scan. It runs in the VACUUM stage instead, where
                        // slowness is expected and shown in the live viz. This wave just
                        // creates the fast HTTP-scraped stub so the citation resolves.
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

            // Short-form footnotes inherit their antecedent's resolution +
            // canonical link (the antecedent resolved in the waves above).
            if ($shortFormMap) {
                $this->inheritShortFormResolutions($db, $shortFormMap);
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

        // Register the stub as a version of its canonical work (identifier-backed
        // sources only). Never fails the scan — a canonical link is a bonus.
        $canonicalId = $this->linkStubToCanonical($stubBookId, $normalised, $matchMethod);

        if ($isLinked) {
            // Only set foundation_source — DO NOT modify source_id
            $this->updateSourceEntry($db, $refId, array_merge([
                'foundation_source'  => $stubBookId,
                'match_method'       => $matchMethod,
                'match_score'        => $score,
                'match_diagnostics'  => $matchDiagnostics ? json_encode($matchDiagnostics) : null,
            ], $this->canonicalColumnFor($canonicalId)));

            return [
                'referenceId'         => $refId,
                'status'              => 'enriched',
                'match_method'        => $matchMethod,
                'searched_title'      => $poolItem['searchedTitle'],
                'result_title'        => $normalised['title'],
                'similarity_score'    => $score,
                'openalex_id'         => $normalised['openalex_id'] ?? null,
                'open_library_key'    => $normalised['open_library_key'] ?? null,
                'foundation_book_id'  => $stubBookId,
                'canonical_source_id' => $canonicalId,
                'is_oa'               => $normalised['is_oa'] ?? null,
                'oa_url'              => $normalised['oa_url'] ?? null,
                'pdf_url'             => $normalised['pdf_url'] ?? null,
                'llm_metadata'        => $poolItem['llmMetadata'],
            ];
        }

        // Unlinked: set both source_id and foundation_source
        $this->updateSourceEntry($db, $refId, array_merge([
            'source_id'          => $stubBookId,
            'foundation_source'  => $stubBookId,
            'match_method'       => $matchMethod,
            'match_score'        => $score,
            'match_diagnostics'  => $matchDiagnostics ? json_encode($matchDiagnostics) : null,
        ], $this->canonicalColumnFor($canonicalId)));

        return [
            'referenceId'         => $refId,
            'status'              => 'newly_resolved',
            'match_method'        => $matchMethod,
            'searched_title'      => $poolItem['searchedTitle'],
            'result_title'        => $normalised['title'],
            'similarity_score'    => $score,
            'openalex_id'         => $normalised['openalex_id'] ?? null,
            'open_library_key'    => $normalised['open_library_key'] ?? null,
            'foundation_book_id'  => $stubBookId,
            'canonical_source_id' => $canonicalId,
            'is_oa'               => $normalised['is_oa'] ?? null,
            'oa_url'              => $normalised['oa_url'] ?? null,
            'pdf_url'             => $normalised['pdf_url'] ?? null,
            'llm_metadata'        => $poolItem['llmMetadata'],
        ];
    }

    /**
     * Link a freshly resolved stub to its canonical work via the matcher's
     * idempotent identifier-first upsert. Returns the canonical id, or null
     * when the source isn't identifier-backed / linking fails. Never throws.
     */
    private function linkStubToCanonical(string $stubBookId, array $normalised, string $matchMethod): ?string
    {
        $foundationSource = self::CANONICAL_FOUNDATION_BY_METHOD[$matchMethod] ?? null;
        if (!$foundationSource) {
            return null;
        }

        try {
            $library = PgLibrary::on('pgsql_admin')->where('book', $stubBookId)->first();
            if (!$library) {
                return null;
            }

            // Re-scan hitting an already-canonicalized stub: reuse the link.
            if ($library->canonical_source_id) {
                return $library->canonical_source_id;
            }

            $canonical = app(CanonicalSourceMatcher::class)->linkFromNormalisedWork(
                $library,
                $normalised,
                $foundationSource,
                'citation_scan_' . $matchMethod,
            );

            return $canonical->id;
        } catch (\Throwable $e) {
            Log::warning('Citation scan: canonical link failed (scan continues)', [
                'scan_id' => $this->scanId,
                'stub'    => $stubBookId,
                'method'  => $matchMethod,
                'error'   => $e->getMessage(),
            ]);
            return null;
        }
    }

    /**
     * bibliography carries canonical_source_id; footnotes does not — there the
     * canonical is reachable via the foundation library row's link instead.
     */
    private function canonicalColumnFor(?string $canonicalId): array
    {
        return ($canonicalId && $this->sourceTable === 'bibliography')
            ? ['canonical_source_id' => $canonicalId]
            : [];
    }

    /**
     * Resolve a pool entry using an already-created stub book ID (web_fetch, brave_search).
     * Updates bibliography and returns result array.
     */
    /**
     * Is $tld a real top-level domain? Covers all ISO 3166-1 country-code TLDs
     * plus the common generic TLDs — so legitimate non-US/UK domains (e.g. the
     * Indian government's pib.gov.in) are NOT flagged as fabricated, while an
     * outright-invalid TLD string (e.g. "google.reports") still is.
     */
    private function isValidTld(string $tld): bool
    {
        return \App\Support\UrlSanity::isValidTld($tld);
    }

    /**
     * Link short-form / ibid footnote citations to their antecedent FULL
     * citations earlier in the same document. Scholarly footnotes give the
     * full reference once, then short forms ("Hart, Justice, pp. 66–7") —
     * extracted in isolation an LLM confabulates the missing details (the
     * H. L. A. Hart bug), so short forms are matched DETERMINISTICALLY here:
     * surname + short-title prefix against earlier full citations, in marker
     * (document) order; ibid → the immediately preceding citation footnote.
     * The LLM is consulted ONLY when several distinct earlier works match —
     * and then it picks among the known candidates given in the prompt.
     *
     * Matched or not, short forms are removed from $needsResolution: resolving
     * a fragment independently is how the wrong work gets linked.
     *
     * @return array short footnoteId => antecedent footnoteId
     */
    private function matchShortFormAntecedents($db, array &$needsResolution, ?callable $disambiguator = null): array
    {
        if ($this->sourceTable !== 'footnotes') {
            return [];
        }

        // Document order: nodes.footnotes carries [{id, marker}] per node.
        $order = [];
        $nodeFootnotes = $db->table('nodes')->where('book', $this->bookId)
            ->whereNotNull('footnotes')->where('footnotes', '!=', '[]')
            ->pluck('footnotes');
        foreach ($nodeFootnotes as $json) {
            foreach (json_decode($json, true) ?: [] as $fn) {
                if (!empty($fn['id']) && isset($fn['marker']) && is_numeric($fn['marker'])) {
                    $m = (int) $fn['marker'];
                    $order[$fn['id']] = isset($order[$fn['id']]) ? min($order[$fn['id']], $m) : $m;
                }
            }
        }
        if (!$order) {
            return [];
        }

        $rows = $db->table('footnotes')->where('book', $this->bookId)
            ->where('is_citation', true)->whereNotNull('llm_metadata')
            ->get(['footnoteId', 'content', 'llm_metadata']);

        $entries = [];
        foreach ($rows as $r) {
            $meta = json_decode($r->llm_metadata, true);
            if (!$meta || !isset($order[$r->footnoteId])) {
                continue;
            }
            $entries[] = [
                'id'     => $r->footnoteId,
                'marker' => $order[$r->footnoteId],
                'meta'   => $meta,
                'text'   => trim(preg_replace('/\s+/', ' ', strip_tags($r->content))),
            ];
        }
        usort($entries, fn($a, $b) => $a['marker'] <=> $b['marker']);

        $norm = fn(?string $s) => trim(preg_replace('/[^\p{L}\p{N}\s]/u', '', mb_strtolower($s ?? '')));
        $surnameOf = function (array $meta) use ($norm): ?string {
            $first = $meta['authors'][0] ?? null;
            if (!is_string($first) || $first === '') return null;
            return $norm(explode(',', $first)[0]);
        };

        $fullForms = [];   // [{idx, id, meta, citation-string}]
        $map = [];         // short id → antecedent id
        $ambiguous = [];   // short id → ['entryIdx' =>, 'candidates' => [fullForm,...]]

        foreach ($entries as $i => $e) {
            $type = $e['meta']['type'] ?? null;

            if ($type === 'ibid') {
                // The immediately preceding citation footnote's EFFECTIVE work
                // (a preceding short form has already been substituted in-place).
                for ($j = $i - 1; $j >= 0; $j--) {
                    $prevType = $entries[$j]['meta']['type'] ?? null;
                    if (in_array($prevType, self::CITABLE_TYPES, true)) {
                        $map[$e['id']] = $entries[$j]['meta']['short_form_of'] ?? $entries[$j]['id'];
                        $entries[$i]['meta'] = array_merge($entries[$j]['meta'], ['short_form_of' => $map[$e['id']]]);
                        break;
                    }
                    if (in_array($prevType, ['short-form', 'ibid'], true)) {
                        // The preceding citation is itself UNLINKED (unknown work) —
                        // this ibid refers to that unknown, not to anything earlier.
                        break;
                    }
                }
                continue;
            }

            if ($type === 'short-form') {
                $surname = $norm($e['meta']['surname'] ?? '');
                $short = $norm($e['meta']['short_title'] ?? '');
                $candidates = [];
                $seenTitles = [];
                // Walk full forms NEAREST-FIRST so candidate #1 is the closest antecedent.
                foreach (array_reverse($fullForms) as $f) {
                    if ($surname !== '' && $f['surname'] !== $surname) continue;
                    $title = $norm($f['meta']['title'] ?? '');
                    if ($short !== '' && $title !== '' && !str_starts_with($title, $short) && !str_contains($title, $short)) continue;
                    if ($surname === '' && $short === '') continue;
                    if (isset($seenTitles[$title])) continue; // same work cited fully twice
                    $seenTitles[$title] = true;
                    $candidates[] = $f;
                }

                if (count($candidates) === 1) {
                    $map[$e['id']] = $candidates[0]['id'];
                    $entries[$i]['meta'] = array_merge($candidates[0]['meta'], ['short_form_of' => $candidates[0]['id']]);
                } elseif (count($candidates) > 1) {
                    $ambiguous[$e['id']] = ['entryIdx' => $i, 'candidates' => $candidates];
                }
                // 0 candidates → stays unlinked (and out of resolution): honest unknown.
                continue;
            }

            // A full citation — becomes an antecedent candidate.
            if (in_array($type, self::CITABLE_TYPES, true) && !empty($e['meta']['title'])) {
                $fullForms[] = [
                    'id'      => $e['id'],
                    'meta'    => $e['meta'],
                    'surname' => $surnameOf($e['meta']) ?? '',
                    'cite'    => implode(', ', array_filter([
                        implode('; ', $e['meta']['authors'] ?? []),
                        $e['meta']['title'] ?? null,
                        $e['meta']['year'] ?? null,
                    ])),
                ];
            }
        }

        // LLM picks among KNOWN candidates for the genuinely ambiguous ones.
        if ($ambiguous && $disambiguator) {
            $items = [];
            foreach ($ambiguous as $shortId => $a) {
                $items[$shortId] = [
                    'short'      => $entries[$a['entryIdx']]['text'],
                    'candidates' => array_map(fn($c) => $c['cite'], $a['candidates']),
                ];
            }
            try {
                $choices = $disambiguator($items);
            } catch (\Throwable $ex) {
                Log::warning('Short-form disambiguation failed', ['error' => $ex->getMessage()]);
                $choices = [];
            }
            foreach ($ambiguous as $shortId => $a) {
                $n = $choices[$shortId] ?? 0;
                if ($n >= 1 && $n <= count($a['candidates'])) {
                    $chosen = $a['candidates'][$n - 1];
                    $map[$shortId] = $chosen['id'];
                    $entries[$a['entryIdx']]['meta'] = array_merge($chosen['meta'], ['short_form_of' => $chosen['id']]);
                }
            }
        }

        // Persist linked metadata; drop ALL short-form/ibid footnotes from
        // independent resolution.
        $shortIds = [];
        foreach ($entries as $e) {
            // detect rows that were short-form/ibid in the stored metadata
            $storedType = $e['meta']['type'] ?? null;
            $isShortRow = isset($map[$e['id']]) || in_array($storedType, ['short-form', 'ibid'], true);
            if (!$isShortRow) continue;
            $shortIds[$e['id']] = true;
            if (isset($map[$e['id']])) {
                $db->table('footnotes')
                    ->where('book', $this->bookId)->where('footnoteId', $e['id'])
                    ->update([
                        'llm_metadata' => json_encode($e['meta']),
                        'match_method' => 'short_form_antecedent',
                        'updated_at'   => now(),
                    ]);
            }
        }
        if ($shortIds) {
            $needsResolution = array_values(array_filter(
                $needsResolution,
                fn($entry) => !isset($shortIds[$entry->referenceId ?? null]),
            ));
        }

        if ($map || $shortIds) {
            Log::info('Short-form footnote antecedents', [
                'book' => $this->bookId, 'linked' => count($map),
                'unlinked_short_forms' => count($shortIds) - count($map),
                'ambiguous_sent_to_llm' => count($ambiguous),
            ]);
        }

        return $map;
    }

    /**
     * Resolve author-date POINTER footnotes against the book's own bibliography.
     * A third citation style (besides body author-date and self-contained
     * citation footnotes): the footnote says "Chapman (2009), p. 6" and the
     * full reference lives in the bibliography. The pointer inherits the
     * bibliography entry's resolution (foundation_source / source_id) — it is
     * NEVER resolved externally, because surname+year without a title is
     * exactly the input that mis-matches to the wrong work.
     *
     * Only unambiguous surname+year matches link; ambiguous (e.g. two 2009
     * works by the same surname) or unmatched pointers stay as they are.
     */
    private function matchBibliographyPointers($db, array &$needsResolution): void
    {
        if ($this->sourceTable !== 'footnotes' || empty($needsResolution)) {
            return;
        }

        $bibRows = $db->table('bibliography')->where('book', $this->bookId)
            ->whereNotNull('llm_metadata')
            ->get(['referenceId', 'llm_metadata', 'foundation_source', 'source_id', 'match_score']);
        if ($bibRows->isEmpty()) {
            return;
        }

        $norm = fn(?string $s) => trim(preg_replace('/[^\p{L}\p{N}\s]/u', '', mb_strtolower($s ?? '')));
        $surnameOf = function (array $meta) use ($norm): ?string {
            $first = $meta['authors'][0] ?? null;
            if (!is_string($first) || $first === '') return null;
            return $norm(explode(',', $first)[0]);
        };

        // Index bibliography by surname|year
        $index = [];
        foreach ($bibRows as $r) {
            $meta = json_decode($r->llm_metadata, true);
            if (!$meta) continue;
            $sur = $surnameOf($meta);
            $yr = $meta['year'] ?? null;
            if ($sur && $yr) {
                $index["{$sur}|{$yr}"][] = $r;
            }
        }
        if (!$index) {
            return;
        }

        // Current footnote metadata (persisted during extraction)
        $fnMeta = [];
        foreach ($db->table('footnotes')->where('book', $this->bookId)
            ->whereNotNull('llm_metadata')->get(['footnoteId', 'llm_metadata']) as $r) {
            $fnMeta[$r->footnoteId] = json_decode($r->llm_metadata, true);
        }

        $linked = 0;
        $linkedIds = [];
        foreach ($needsResolution as $entry) {
            $fnId = $entry->referenceId ?? null;
            $meta = $fnMeta[$fnId] ?? null;
            if (!$meta) continue;
            // A pointer = author-date with no/short title; a footnote carrying a
            // full reference (real title) should resolve through the normal waves.
            $title = $meta['title'] ?? null;
            if (is_string($title) && mb_strlen(trim($title)) > 25) continue;

            $sur = $surnameOf($meta);
            $yr = $meta['year'] ?? null;
            if (!$sur || !$yr) continue;

            $candidates = $index["{$sur}|{$yr}"] ?? [];
            if (count($candidates) !== 1) continue; // ambiguous or absent — leave honest

            $bib = $candidates[0];
            $meta['bibliography_ref'] = $bib->referenceId;
            $update = [
                'llm_metadata' => json_encode($meta),
                'match_method' => 'bibliography_pointer',
                'match_score'  => $bib->match_score ?? 1.0,
                'updated_at'   => now(),
            ];
            if (!empty($bib->foundation_source)) {
                $update['foundation_source'] = $bib->foundation_source;
                $update['source_id'] = $bib->source_id;
            }
            $db->table('footnotes')->where('book', $this->bookId)
                ->where('footnoteId', $fnId)->update($update);

            $linkedIds[$fnId] = true;
            $linked++;
        }

        if ($linkedIds) {
            // Linked pointers never go through external resolution.
            $needsResolution = array_values(array_filter(
                $needsResolution,
                fn($e) => !isset($linkedIds[$e->referenceId ?? null]),
            ));
            Log::info('Bibliography-pointer footnotes linked', [
                'book' => $this->bookId, 'linked' => $linked,
            ]);
        }
    }

    /**
     * Remove legislation / case-law citations from external resolution. They
     * COUNT as citations (claims anchor on their markers, the report lists
     * them) but an instrument string ("Art. 5(3)(a) ISD") or a case number is
     * not a scholarly-database query — sending it to the waves is mis-match
     * risk for zero gain. Returns how many were excluded.
     */
    private function excludeLegalFromResolution($db, array &$needsResolution): int
    {
        if ($this->sourceTable !== 'footnotes' || empty($needsResolution)) {
            return 0;
        }
        $legalIds = [];
        foreach ($db->table('footnotes')->where('book', $this->bookId)
            ->whereNotNull('llm_metadata')->get(['footnoteId', 'llm_metadata']) as $r) {
            $meta = json_decode($r->llm_metadata, true);
            if (in_array($meta['type'] ?? null, ['legislation', 'case-law'], true)) {
                $legalIds[$r->footnoteId] = true;
            }
        }
        if (!$legalIds) {
            return 0;
        }
        $before = count($needsResolution);
        $needsResolution = array_values(array_filter(
            $needsResolution,
            fn($e) => !isset($legalIds[$e->referenceId ?? null]),
        ));
        return $before - count($needsResolution);
    }

    /**
     * After the resolution waves: each short-form footnote inherits its
     * antecedent's resolution + canonical link, so six "Hart, Justice"
     * footnotes share ONE resolved source instead of resolving (wrongly) alone.
     */
    private function inheritShortFormResolutions($db, array $shortFormMap): void
    {
        foreach ($shortFormMap as $shortId => $antecedentId) {
            $ante = $db->table('footnotes')
                ->where('book', $this->bookId)->where('footnoteId', $antecedentId)
                ->first(['foundation_source', 'source_id', 'match_score']);
            if (!$ante || empty($ante->foundation_source)) {
                continue; // antecedent unresolved — short form stays unresolved too
            }
            $db->table('footnotes')
                ->where('book', $this->bookId)->where('footnoteId', $shortId)
                ->update([
                    'foundation_source' => $ante->foundation_source,
                    'source_id'         => $ante->source_id,
                    'match_method'      => 'short_form_antecedent',
                    'match_score'       => $ante->match_score ?? 1.0,
                    'updated_at'        => now(),
                ]);
        }
    }

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
            ->get(['book', 'title', 'author', 'year', 'openalex_id', 'open_library_key', 'canonical_source_id']);

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

        if ($bestMatch && $bestScore >= 0.5 && $this->hasTitleConfidence($bestDiagnostics, $bestScore)) {
            return [
                'book'                => $bestMatch->book,
                'title'               => $bestMatch->title,
                'score'               => round($bestScore, 3),
                'diagnostics'         => $bestDiagnostics,
                'openalex_id'         => $bestMatch->openalex_id,
                'open_library_key'    => $bestMatch->open_library_key,
                'canonical_source_id' => $bestMatch->canonical_source_id,
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
     * Title floor: a candidate whose TITLE component is weak must not be
     * accepted no matter how high the composite score — author + journal
     * fuzz can drag a same-author-different-work candidate over the
     * composite threshold (live case: "Peer review" matched "Credibility,
     * peer review, and Nature, 1945–1990", titleScore 0.24, composite 0.41,
     * both by Melinda Baldwin). A wrong link is worse than no link.
     *
     * When the scorer ran title-only (no LLM metadata), the composite IS the
     * title similarity, so the floor falls back to it.
     */
    private function hasTitleConfidence(?array $diagnostics, float $score): bool
    {
        $titleScore = $diagnostics['titleScore'] ?? $score;

        return $titleScore >= 0.45;
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
