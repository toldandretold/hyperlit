<?php

namespace App\Services\OpenAlex;

use Illuminate\Support\Facades\Log;

/**
 * Query layer for the OpenAlex /sources endpoint (journals, conference series,
 * repositories). Powers the diamond-journal registry sync: cursor-paged listing
 * plus single-journal lookup by ISSN. Results come back raw — SourceNormaliser
 * maps them into the journal_sources column shape.
 */
class SourcesApi
{
    /**
     * Everything the registry stores about a journal. summary_stats carries
     * 2yr_mean_citedness; host_organization_name is the publisher (null for
     * many small society journals — DOAJ backfills it).
     */
    public const SELECT_FIELDS = 'id,display_name,issn_l,issn,is_oa,is_in_doaj,apc_usd,works_count,cited_by_count,summary_stats,country_code,homepage_url,host_organization_name,topics';

    public function __construct(
        private OpenAlexHttpClient $http,
    ) {
    }

    /**
     * One cursor page of /sources. Pass cursor '*' to start, then the returned
     * next_cursor until it comes back null. Non-user-facing: rides the 429
     * backoff and proactive throttle.
     *
     * @return array{sources: array<int, array>, next_cursor: ?string, count: ?int}
     */
    public function fetchSourcesPage(string $filter, ?string $cursor = '*', int $perPage = 200, ?string $sort = 'cited_by_count:desc'): array
    {
        $query = [
            'filter'   => $filter,
            'per_page' => $perPage,
            'cursor'   => $cursor ?? '*',
            'select'   => self::SELECT_FIELDS,
        ];
        if ($sort !== null) {
            $query['sort'] = $sort;
        }

        $response = $this->http->retryableGet(OpenAlexHttpClient::BASE_URL . '/sources', $query);

        if (!$response->successful()) {
            Log::warning('OpenAlex /sources returned ' . $response->status(), ['filter' => $filter]);
            throw new \RuntimeException('OpenAlex /sources returned ' . $response->status());
        }

        return [
            'sources'     => $response->json('results') ?? [],
            'next_cursor' => $response->json('meta.next_cursor'),
            'count'       => $response->json('meta.count'),
        ];
    }

    /**
     * Look one source up by any of its ISSNs (the `issn` filter matches both
     * issn_l and the issn list). Returns the raw source object or null.
     */
    public function fetchByIssn(string $issn): ?array
    {
        $response = $this->http->retryableGet(OpenAlexHttpClient::BASE_URL . '/sources', [
            'filter'   => 'issn:' . trim($issn),
            'per_page' => 1,
            'select'   => self::SELECT_FIELDS,
        ]);

        if (!$response->successful()) {
            Log::warning('OpenAlex /sources ISSN lookup returned ' . $response->status(), ['issn' => $issn]);
            return null;
        }

        $results = $response->json('results') ?? [];

        return $results[0] ?? null;
    }
}
