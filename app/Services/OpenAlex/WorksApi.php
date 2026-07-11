<?php

namespace App\Services\OpenAlex;

use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Log;

/**
 * Query layer for the OpenAlex /works and /authors endpoints.
 * Every result comes back already run through WorkNormaliser, so callers
 * only ever see the shared citation shape.
 */
class WorksApi
{
    public function __construct(
        private OpenAlexHttpClient $http,
        private WorkNormaliser $normaliser,
    ) {
    }

    /**
     * Fetch works from OpenAlex by search query and normalise them.
     *
     * @return array<int, array>
     */
    public function fetchFromOpenAlex(string $query, int $limit = 10, int $page = 1, bool $userFacing = false, bool $throwOnFailure = false): array
    {
        $response = $this->http->retryableGet(OpenAlexHttpClient::BASE_URL . '/works', [
            'search'   => $query,
            'per_page' => $limit,
            'page'     => $page,
            'select'   => OpenAlexHttpClient::SELECT_FIELDS,
        ], $userFacing);

        if (!$response->successful()) {
            Log::warning('OpenAlex API returned ' . $response->status() . ' for query: ' . $query);
            if ($throwOnFailure) {
                // Callers that need to distinguish "source down" from "source
                // had nothing" (the citation ingest job's status reporting)
                // opt into an exception instead of a silent empty array.
                throw new \RuntimeException('OpenAlex API returned ' . $response->status());
            }
            return [];
        }

        $works = $response->json('results') ?? [];

        return array_map(fn(array $work) => $this->normaliser->normaliseWork($work), $works);
    }

    /**
     * Fetch works by author name from OpenAlex (two-step: resolve author -> fetch works).
     *
     * @return array<int, array>
     */
    public function fetchFromOpenAlexByAuthor(string $query, int $limit = 10): array
    {
        $authorResponse = $this->http->retryableGet(OpenAlexHttpClient::BASE_URL . '/authors', [
            'search'   => $query,
            'per_page' => 1,
            'select'   => 'id',
        ]);

        if (!$authorResponse->successful()) {
            return [];
        }

        $authors = $authorResponse->json('results') ?? [];
        if (empty($authors)) {
            return [];
        }

        $authorId = $authors[0]['id'] ?? null;
        if (!$authorId) {
            return [];
        }

        $worksResponse = $this->http->retryableGet(OpenAlexHttpClient::BASE_URL . '/works', [
            'filter'   => 'authorships.author.id:' . $authorId,
            'per_page' => $limit,
            'sort'     => 'cited_by_count:desc',
            'select'   => OpenAlexHttpClient::SELECT_FIELDS,
        ]);

        if (!$worksResponse->successful()) {
            return [];
        }

        $works = $worksResponse->json('results') ?? [];

        return array_map(fn(array $work) => $this->normaliser->normaliseWork($work), $works);
    }

    /**
     * Fetch a single work by DOI from OpenAlex.
     * Returns a normalised work array, or null if not found.
     */
    public function fetchByDoi(string $doi): ?array
    {
        $response = $this->http->retryableGet(OpenAlexHttpClient::BASE_URL . '/works/doi:' . $doi, [
            'select' => OpenAlexHttpClient::SELECT_FIELDS,
        ]);

        if (!$response->successful()) {
            return null;
        }

        $work = $response->json();
        if (empty($work) || empty($work['id'])) {
            return null;
        }

        return $this->normaliser->normaliseWork($work);
    }

    /**
     * Fetch multiple works by DOI concurrently via the pooled batch loop.
     *
     * @param array $dois Keyed by referenceId: ['ref1' => '10.xxx/yyy', ...]
     * @return array Normalised works keyed by referenceId (null for failures)
     */
    public function fetchByDoiBatch(array $dois): array
    {
        $requests = [];
        foreach ($dois as $key => $doi) {
            $requests[$key] = [
                'url'   => OpenAlexHttpClient::BASE_URL . '/works/doi:' . $doi,
                'query' => ['select' => OpenAlexHttpClient::SELECT_FIELDS],
            ];
        }

        return $this->http->pooledGet(
            $requests,
            function (Response $response) {
                $work = $response->json();
                return (!empty($work) && !empty($work['id']))
                    ? $this->normaliser->normaliseWork($work)
                    : null;
            },
            null,
            'batch DOI'
        );
    }

    /**
     * The OpenAlex ids of every work this work cites (its outbound citation
     * graph). Not part of SELECT_FIELDS — referenced_works can be hundreds of
     * entries, so it is fetched on demand per work. Empty array when OpenAlex
     * has no reference data (common for books/monographs) or on failure.
     *
     * @return array<int, string> e.g. ['W2126853606', ...]
     */
    public function fetchReferencedWorkIds(string $openalexId): array
    {
        $response = $this->http->retryableGet(OpenAlexHttpClient::BASE_URL . '/works/' . $openalexId, [
            'select' => 'referenced_works',
        ]);

        if (!$response->successful()) {
            return [];
        }

        $referenced = $response->json('referenced_works') ?? [];

        // OpenAlex returns full URLs (https://openalex.org/W...) — keep bare ids.
        return array_values(array_filter(array_map(
            fn($url) => $url ? basename((string) $url) : null,
            $referenced
        )));
    }

    /**
     * Fetch many works by OpenAlex id via the batch filter endpoint
     * (ids.openalex OR-filter, 50 ids per request) through the pooled loop.
     * Powers the referenced_works closed-pool citation matching.
     *
     * @param array<int, string> $openalexIds bare ids ('W...')
     * @return array<int, array> normalised works (order not guaranteed)
     */
    public function fetchByIdsBatch(array $openalexIds): array
    {
        $openalexIds = array_values(array_unique(array_filter($openalexIds)));
        if (empty($openalexIds)) {
            return [];
        }

        $requests = [];
        foreach (array_chunk($openalexIds, 50) as $i => $chunk) {
            $requests[$i] = [
                'url'   => OpenAlexHttpClient::BASE_URL . '/works',
                'query' => [
                    'filter'   => 'ids.openalex:' . implode('|', $chunk),
                    'per_page' => count($chunk),
                    'select'   => OpenAlexHttpClient::SELECT_FIELDS,
                ],
            ];
        }

        $chunkResults = $this->http->pooledGet(
            $requests,
            function (Response $response) {
                $works = $response->json('results') ?? [];
                return array_map(fn(array $work) => $this->normaliser->normaliseWork($work), $works);
            },
            [],
            'batch ids'
        );

        return array_merge(...array_values(array_map(fn($r) => $r ?: [], $chunkResults)));
    }

    /**
     * Search OpenAlex for multiple queries concurrently via the pooled batch loop.
     *
     * @param array $queries Keyed by referenceId: ['ref1' => 'search title', ...]
     * @return array Arrays of normalised candidates keyed by referenceId
     */
    public function searchBatch(array $queries, int $limit = 5, array $yearFilters = []): array
    {
        $requests = [];
        foreach ($queries as $key => $query) {
            $params = [
                'search'   => $query,
                'per_page' => $limit,
                'page'     => 1,
                'select'   => OpenAlexHttpClient::SELECT_FIELDS,
            ];
            if (isset($yearFilters[$key])) {
                $params['filter'] = 'publication_year:' . (int) $yearFilters[$key];
            }
            $requests[$key] = [
                'url'   => OpenAlexHttpClient::BASE_URL . '/works',
                'query' => $params,
            ];
        }

        return $this->http->pooledGet(
            $requests,
            function (Response $response) {
                $works = $response->json('results') ?? [];
                return array_map(fn(array $work) => $this->normaliser->normaliseWork($work), $works);
            },
            [],
            'batch search'
        );
    }
}
