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
 * NOTE (local dev): QUEUE_CONNECTION=database — this job only runs if a worker
 * is running (`php artisan queue:work` or `npm run dev:all`). In tests
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
    ) {}

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

    public function handle(
        OpenAlexService $openAlex,
        OpenLibraryService $openLibrary,
        CanonicalSourceMatcher $canonicalMatcher,
    ): void {
        // userFacing=false: nobody is waiting on this — let the polite proactive
        // throttle apply so background ingest never burns the OpenAlex quota.
        $openAlexCandidates = [];
        $openLibraryCandidates = [];

        try {
            $openAlexCandidates = $openAlex->fetchFromOpenAlex($this->query, $this->perSource, 1, userFacing: false);
        } catch (\Throwable $e) {
            Log::warning('IngestExternalCitationCandidatesJob: OpenAlex fetch failed', ['error' => $e->getMessage()]);
        }

        try {
            $openLibraryCandidates = $openLibrary->search($this->query, null, $this->perSource);
        } catch (\Throwable $e) {
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
            Cache::increment(self::generationKey($this->query));
        }
    }
}
