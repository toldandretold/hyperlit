<?php

namespace App\Services;

use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * Orchestrates citation modal search:
 *   1. Hybrid local search (canonical_source UNION orphan library) via SearchService.
 *   2. On public scope with thin results, supplement with OpenAlex + Open Library
 *      and write the new records to canonical_source ONLY (no library stubs).
 *   3. Re-run local search so the just-ingested canonicals appear in the response.
 *
 * Semantic Scholar is intentionally NOT in the live path — its rate-gate is a
 * process-level static that can't parallelise and serialises against the cron.
 * SS continues to enrich canonicals through library:canonicalize.
 *
 * Test coverage:
 *   - tests/Unit/Services/CitationSearchServiceTest.php (Pest, Mockery)
 *       Pure orchestration: gating rules, ingest routing, cache short-circuit.
 *   - tests/Feature/Citations/CitationSearchTest.php (Pest, Http::fake)
 *       End-to-end through the controller: scope/privacy contract, canonical-
 *       only ingest, hybrid result shapes, is_private flag, validation, etc.
 * See tests/Feature/Citations/README.md for the full suite map.
 */
class CitationSearchService
{
    public const EXTERNAL_PER_SOURCE = 5;

    /**
     * Skip external lookup for the same query within this window. Prevents
     * back-to-back searches (typing pauses, scope toggles) from re-hitting
     * OpenAlex/Open Library when we already ingested everything they'd return.
     */
    public const EXTERNAL_LOOKUP_TTL_SECONDS = 900;

    public function __construct(
        private SearchService $search,
        private OpenAlexService $openAlex,
        private OpenLibraryService $openLibrary,
        private CanonicalSourceMatcher $canonicalMatcher,
    ) {}

    /**
     * @return array{
     *   results: array,
     *   has_more: bool,
     *   external_ingested: int,
     * }
     */
    public function search(
        string $query,
        int $limit = 15,
        int $offset = 0,
        string $sourceScope = 'public',
        ?string $shelfId = null,
        ?string $creatorName = null,
    ): array {
        $local = $this->search->searchForCitations($query, $limit, $offset, $sourceScope, $creatorName, $shelfId);

        $externalIngested = 0;

        // External lookup gated on public scope + thin local results.
        //   - mine/shelf shouldn't pull global noise
        //   - first page only (offset=0) — "load more" shouldn't re-ingest
        //   - only when the local page is not full; if we filled the requested
        //     limit from cached canonicals + library, external can't help.
        if ($sourceScope === 'public' && $offset === 0 && count($local) < $limit) {
            $cacheKey = 'citation_search:external:' . sha1(mb_strtolower(trim($query)));
            if (!Cache::has($cacheKey)) {
                $externalIngested = $this->ingestExternal($query, self::EXTERNAL_PER_SOURCE);
                Cache::put($cacheKey, true, self::EXTERNAL_LOOKUP_TTL_SECONDS);

                // Re-run hybrid search so newly upserted canonicals fold in
                if ($externalIngested > 0) {
                    $local = $this->search->searchForCitations($query, $limit, $offset, $sourceScope, $creatorName, $shelfId);
                }
            }
        }

        return [
            'results'           => $local,
            'has_more'          => count($local) >= $limit,
            'external_ingested' => $externalIngested,
        ];
    }

    /**
     * Fetches from OpenAlex + Open Library and writes each candidate to canonical_source
     * via CanonicalSourceMatcher::ingestExternal. Returns the count of candidates
     * successfully ingested (existing canonicals count as ingested too — idempotent).
     */
    private function ingestExternal(string $query, int $limit): int
    {
        // Both calls are user-facing; OpenAlex skips throttle sleeps via userFacing=true.
        // Sequential rather than parallel — Open Library has no rate gate to worry about
        // and two calls is well under the perceived-latency threshold post-PR1.
        $openAlexCandidates = [];
        $openLibraryCandidates = [];

        try {
            $openAlexCandidates = $this->openAlex->fetchFromOpenAlex($query, $limit, 1, userFacing: true);
        } catch (\Throwable $e) {
            Log::warning('CitationSearchService: OpenAlex fetch failed', ['error' => $e->getMessage()]);
        }

        try {
            $openLibraryCandidates = $this->openLibrary->search($query, null, $limit);
        } catch (\Throwable $e) {
            Log::warning('CitationSearchService: Open Library fetch failed', ['error' => $e->getMessage()]);
        }

        $ingested = 0;
        foreach (array_merge($openAlexCandidates, $openLibraryCandidates) as $candidate) {
            $foundationSource = match (true) {
                !empty($candidate['openalex_id'])      => 'openalex_citation_search',
                !empty($candidate['open_library_key']) => 'open_library_citation_search',
                default                                => 'citation_search_unknown',
            };

            try {
                $this->canonicalMatcher->ingestExternal($candidate, $foundationSource);
                $ingested++;
            } catch (\Throwable $e) {
                Log::warning('CitationSearchService: ingestExternal failed', [
                    'error'     => $e->getMessage(),
                    'candidate' => Arr::only($candidate, ['title', 'openalex_id', 'open_library_key', 'doi']),
                ]);
            }
        }

        return $ingested;
    }
}
