<?php

namespace App\Jobs;

use App\Services\CanonicalSourceMatcher;
use App\Services\OpenAlexService;
use App\Services\OpenLibraryService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * Background supplement for citation search: fetches candidates from OpenAlex +
 * Open Library and writes them to canonical_source (never library stubs).
 *
 * Dispatched by CitationSearchService when a public first-page search returns
 * thin local results. Moving this out of the request path is what keeps
 * /api/search/combined fast — external APIs cost 1s on a good day and 15s+ on
 * a bad one (timeouts + 429 sleep-backoff), and none of that may block a
 * keystroke-driven search. The frontend re-queries once ~2.5s after a response
 * with external_pending=true to fold the new canonicals in.
 *
 * On successful ingest this bumps the per-query GENERATION counter, which is a
 * segment of the /api/search/combined response-cache key — so the frontend's
 * re-query naturally misses the cache and sees the new rows.
 *
 * QUEUE: dedicated `search-supplement` queue (hyperlit-search worker in prod,
 * SRCH in `npm run dev:all`) — a user is actively polling the modal for these
 * results, so this must NEVER wait behind a 15-min document import on
 * `default`. See deploy/supervisor/README.md invariant #1: this onQueue and
 * the worker conf ship together.
 *
 * NOTE (local dev): QUEUE_CONNECTION=database — this job only runs if a worker
 * serves the queue (`npm run dev:all`, or manually
 * `php artisan queue:work --queue=search-supplement`). In tests
 * (QUEUE_CONNECTION=sync) it executes inline; in prod, supervisor workers.
 */
class IngestExternalCitationCandidatesJob implements ShouldQueue, ShouldBeUnique
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 120; // two external APIs, worst-case retries included
    public int $tries = 1;

    public function __construct(
        public string $query,
        public int $perSource,
    ) {
        $this->onQueue('search-supplement');
    }

    /**
     * One in-flight ingest per normalized query (belt-and-braces on top of the
     * 900s dedup key the service sets before dispatching).
     */
    public function uniqueId(): string
    {
        return sha1(mb_strtolower(trim($this->query)));
    }

    /** Cache key of the generation counter for a given (raw) query. */
    public static function generationKey(string $query): string
    {
        return 'citation_search:external_gen:' . sha1(mb_strtolower(trim($query)));
    }

    /**
     * Cache key of the "already asked the external APIs for this query" flag.
     * CitationSearchService sets it with a SHORT ttl at dispatch (spam guard);
     * handle() re-sets it with the full 15-min courtesy window once the fetch
     * has actually happened — so a dead worker never locks a query out.
     */
    public static function dedupKey(string $query): string
    {
        return 'citation_search:external:' . sha1(mb_strtolower(trim($query)));
    }

    /**
     * Cache key of the job's outcome for a query: 'completed' (the sources
     * answered — even with nothing) or 'sources_failed' (every source errored
     * and nothing was ingested, so the emptiness can't be trusted). The search
     * response surfaces it as `external_status` so the modal can tell the user
     * "external databases are unreachable" instead of a misleading
     * "no results found". Absent while the job is still queued/running.
     */
    public static function statusKey(string $query): string
    {
        return 'citation_search:external_status:' . sha1(mb_strtolower(trim($query)));
    }

    public function handle(
        OpenAlexService $openAlex,
        OpenLibraryService $openLibrary,
        CanonicalSourceMatcher $canonicalMatcher,
    ): void {
        // userFacing=false: nobody is waiting on this — let the polite proactive
        // throttle apply so background ingest never burns the OpenAlex quota.
        // throwOnFailure=true: we need to distinguish "source down" from
        // "source had nothing" for the status the modal shows the user.
        $openAlexCandidates = [];
        $openLibraryCandidates = [];
        $openAlexFailed = false;
        $openLibraryFailed = false;

        try {
            $openAlexCandidates = $openAlex->fetchFromOpenAlex($this->query, $this->perSource, 1, userFacing: false, throwOnFailure: true);
        } catch (\Throwable $e) {
            $openAlexFailed = true;
            Log::warning('IngestExternalCitationCandidatesJob: OpenAlex fetch failed', ['error' => $e->getMessage()]);
        }

        try {
            $openLibraryCandidates = $openLibrary->search($this->query, null, $this->perSource, throwOnFailure: true);
        } catch (\Throwable $e) {
            $openLibraryFailed = true;
            Log::warning('IngestExternalCitationCandidatesJob: Open Library fetch failed', ['error' => $e->getMessage()]);
        }

        $ingested = 0;
        foreach (array_merge($openAlexCandidates, $openLibraryCandidates) as $candidate) {
            $foundationSource = match (true) {
                !empty($candidate['openalex_id'])      => 'openalex_citation_search',
                !empty($candidate['open_library_key']) => 'open_library_citation_search',
                default                                => 'citation_search_unknown',
            };

            try {
                $canonicalMatcher->ingestExternal($candidate, $foundationSource);
                $ingested++;
            } catch (\Throwable $e) {
                Log::warning('IngestExternalCitationCandidatesJob: ingestExternal failed', [
                    'error'     => $e->getMessage(),
                    'candidate' => Arr::only($candidate, ['title', 'openalex_id', 'open_library_key', 'doi']),
                ]);
            }
        }

        if ($ingested > 0) {
            // Invalidates the combined-search response cache for this query
            // (the generation is a cache-key segment) so re-queries see the
            // newly ingested canonicals.
            //
            // NOT Cache::increment(): on the DATABASE cache store increment
            // silently no-ops when the key doesn't exist yet (it only UPDATEs
            // an existing row), while the array store used in tests
            // auto-initializes — the bump vanished in dev/prod and polls kept
            // hitting the cached-empty page. Caught by the full-real e2e spec
            // (citation-external-supplement). Read-modify-write is safe here:
            // ShouldBeUnique means no concurrent job for the same query.
            $genKey = self::generationKey($this->query);
            Cache::put($genKey, (int) Cache::get($genKey, 0) + 1, 3600);
        }

        // The external fetch genuinely happened (even if it returned nothing) —
        // start the full courtesy window now so we don't re-ask the APIs for
        // this query for a while. Replaces the short spam-guard ttl the
        // service set at dispatch time.
        Cache::put(
            self::dedupKey($this->query),
            true,
            \App\Services\CitationSearchService::EXTERNAL_LOOKUP_TTL_SECONDS
        );

        // Outcome for the modal: an empty result is only trustworthy when at
        // least one source actually answered. If a source failed but the other
        // still yielded ingests, the user has results — call it completed.
        $state = (($openAlexFailed && $openLibraryFailed) || (($openAlexFailed || $openLibraryFailed) && $ingested === 0))
            ? 'sources_failed'
            : 'completed';
        Cache::put(
            self::statusKey($this->query),
            $state,
            \App\Services\CitationSearchService::EXTERNAL_LOOKUP_TTL_SECONDS
        );
    }
}
