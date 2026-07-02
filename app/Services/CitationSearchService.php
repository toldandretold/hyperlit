<?php

namespace App\Services;

use App\Jobs\IngestExternalCitationCandidatesJob;
use Illuminate\Support\Facades\Cache;

/**
 * Orchestrates citation modal search:
 *   1. Hybrid local search (canonical_source UNION orphan library) via SearchService.
 *   2. On public scope with thin results, DISPATCH a background job that
 *      supplements from OpenAlex + Open Library into canonical_source ONLY
 *      (no library stubs) — external HTTP never blocks the request. The
 *      response signals `external_pending`; the frontend re-queries once
 *      ~2.5s later to fold the newly ingested canonicals in.
 *
 * Semantic Scholar is intentionally NOT in the live path — its rate-gate is a
 * process-level static that can't parallelise and serialises against the cron.
 * SS continues to enrich canonicals through library:canonicalize.
 *
 * Test coverage:
 *   - tests/Unit/Services/CitationSearchServiceTest.php (Pest, Mockery + Bus::fake)
 *       Pure orchestration: gating rules, dispatch rules, cache short-circuit.
 *   - tests/Unit/Jobs/IngestExternalCitationCandidatesJobTest.php
 *       The moved ingest body: source routing, failure isolation, generation bump.
 *   - tests/Feature/Citations/CitationSearchTest.php (Pest, Http::fake)
 *       End-to-end through the controller: scope/privacy contract, canonical-
 *       only ingest, hybrid result shapes, is_private flag, validation, etc.
 *       (QUEUE_CONNECTION=sync in phpunit.xml — the job runs inline there.)
 * See tests/Feature/Citations/README.md for the full suite map.
 */
class CitationSearchService
{
    public const EXTERNAL_PER_SOURCE = 5;

    /**
     * Skip external lookup for the same query within this window. Prevents
     * back-to-back searches (typing pauses, scope toggles) from re-hitting
     * OpenAlex/Open Library when we already ingested everything they'd return.
     * Written by the ingest JOB when the fetch actually completes.
     */
    public const EXTERNAL_LOOKUP_TTL_SECONDS = 900;

    /**
     * Short hold set at DISPATCH time (before the job has run) — enough to
     * stop keystroke spam double-dispatching, but short enough that a dead
     * queue worker doesn't lock the query out of supplementation for the full
     * courtesy window. The job replaces it with EXTERNAL_LOOKUP_TTL_SECONDS
     * on completion.
     */
    public const EXTERNAL_DISPATCH_TTL_SECONDS = 120;

    /**
     * Response cache for the local hybrid SQL (mirrors searchNodes' 60s cache).
     * Keyed by every input that affects the result (query/scope/creator/shelf/
     * limit/offset) PLUS the per-query external-ingest generation counter, so a
     * completed background ingest naturally invalidates the cached page.
     */
    public const RESULTS_CACHE_TTL_SECONDS = 60;

    public function __construct(
        private SearchService $search,
    ) {}

    /**
     * @return array{
     *   results: array,
     *   has_more: bool,
     *   external_ingested: int,
     *   external_pending: bool,
     *   external_status: ?string,
     *   timings: array<string, float>,
     * }
     *
     * `external_status` (only set for thin public first pages, else null):
     *   'dispatched'     — THIS request queued the ingest job
     *   'pending'        — job queued/running, outcome not yet known
     *   'completed'      — sources answered (results, or genuinely nothing)
     *   'sources_failed' — every source errored and nothing was ingested;
     *                      an empty result page is NOT trustworthy
     * The modal uses it to word the empty state honestly.
     *
     * `external_ingested` is DEPRECATED (always 0 since ingest went async) —
     * kept for one release so existing consumers don't break; use
     * `external_pending` instead.
     */
    public function search(
        string $query,
        int $limit = 15,
        int $offset = 0,
        string $sourceScope = 'public',
        ?string $shelfId = null,
        ?string $creatorName = null,
    ): array {
        $ms = fn (int $since) => round((hrtime(true) - $since) / 1e6, 1);
        $timings = [];

        // Cache key covers EVERY argument that shapes the result — identical
        // inputs are the only way to share an entry, so there is no scope /
        // creator / shelf cross-contamination path. The generation counter
        // (bumped by IngestExternalCitationCandidatesJob on successful ingest)
        // rolls the key so post-ingest re-queries see the new canonicals.
        $generation = (int) Cache::get(IngestExternalCitationCandidatesJob::generationKey($query), 0);
        $resultsKey = 'search:combined:' . sha1(json_encode([
            mb_strtolower(trim($query)), $limit, $offset, $sourceScope, $shelfId, $creatorName, $generation,
        ]));

        $t = hrtime(true);
        $local = Cache::remember(
            $resultsKey,
            self::RESULTS_CACHE_TTL_SECONDS,
            fn () => $this->search->searchForCitations($query, $limit, $offset, $sourceScope, $creatorName, $shelfId)
        );
        $timings['local_ms'] = $ms($t);

        $externalPending = false;

        // External lookup gated on public scope + thin local results.
        //   - mine/shelf shouldn't pull global noise
        //   - first page only (offset=0) — "load more" shouldn't re-ingest
        //   - only when the local page is not full; if we filled the requested
        //     limit from cached canonicals + library, external can't help.
        // The lookup itself runs in a queued job — external HTTP (1s good day,
        // 15s+ bad day) must never block a keystroke-driven search request.
        $externalStatus = null;

        if ($sourceScope === 'public' && $offset === 0 && count($local) < $limit) {
            $cacheKey = IngestExternalCitationCandidatesJob::dedupKey($query);
            if (!Cache::has($cacheKey)) {
                $t = hrtime(true);
                // Short spam-guard hold only — the job writes the full
                // courtesy window when the fetch actually completes.
                Cache::put($cacheKey, true, self::EXTERNAL_DISPATCH_TTL_SECONDS);
                IngestExternalCitationCandidatesJob::dispatch($query, self::EXTERNAL_PER_SOURCE);
                $externalPending = true;
                $externalStatus = 'dispatched';
                $timings['dispatch_ms'] = $ms($t);
            } else {
                // Ingest already dispatched for this query: outcome known
                // ('completed' / 'sources_failed'), or still in flight.
                $externalStatus = Cache::get(IngestExternalCitationCandidatesJob::statusKey($query)) ?? 'pending';
            }
        }

        return [
            'results'           => $local,
            'has_more'          => count($local) >= $limit,
            'external_ingested' => 0,
            'external_pending'  => $externalPending,
            'external_status'   => $externalStatus,
            'timings'           => $timings,
        ];
    }
}
