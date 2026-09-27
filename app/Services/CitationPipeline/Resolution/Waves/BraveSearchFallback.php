<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\BraveSearchService;
use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use App\Services\WebFetchService;
use Illuminate\Support\Facades\Log;

/**
 * Brave web search (old Wave 8) — the last rung, and the one with the sharpest teeth.
 *
 * Everything cheaper has failed by the time this runs, so the query is the citation's title,
 * author and year against the open web. The load-bearing detail is `cited_url`: the URL the
 * citation PRINTS rides along so a title hit on a DIFFERENT host can be refused
 * (BraveSearchService::hostAgreesWithCitedUrl). By this wave the printed URL has already been
 * tried and failed — usually a 403, which says the host refused US, not that the work lives
 * elsewhere. Searching the title and accepting whatever shares it is how "Social Security
 * Guide" on guides.dss.gov.au became a US financial-planning blog, 12,514 characters of which
 * were stored as the source for an Australian welfare-law citation.
 */
class BraveSearchFallback implements ResolutionWave
{
    public function id(): string
    {
        return 'brave_search_fallback';
    }

    public function title(): string
    {
        return 'Open web search (Brave)';
    }

    public function plain(): string
    {
        return 'As a last resort we searched the open web for the citation. A result was only '
            . 'accepted from the same website the citation itself named, when it named one — a '
            . 'page merely sharing the title is not the source.';
    }

    public function dev(): string
    {
        return 'searchAndFetchBatch(title + authors + year + cited_url). Host agreement against '
            . 'the printed URL refuses cross-host title hits; hits are fetched, screened and '
            . 'minted as stubs inside the service. Resolves via resolveWithStub(brave_search).';
    }

    public function entryGate(): string
    {
        return 'Unresolved entries with a searchable title, and a Brave API key configured.';
    }

    public function acceptGate(): string
    {
        return 'A fetched page passing the relevance screen, on the cited host when the citation '
            . 'prints one.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [] && (bool) config('services.brave_search.api_key');
    }

    public function run(ResolutionContext $ctx): void
    {
        $braveQueries = [];
        foreach ($ctx->pool as $refId => $item) {
            if (!$item['searchedTitle']) {
                continue;
            }
            $stubAuthor = !empty($item['llmMetadata']['authors']) ? implode('; ', $item['llmMetadata']['authors']) : null;
            $citedUrl = app(WebFetchService::class)->extractUrl((string) ($item['content'] ?? ''))
                ?: ($item['llmMetadata']['url'] ?? null);
            $braveQueries[$refId] = [
                'title'     => $item['searchedTitle'],
                'author'    => $stubAuthor,
                'year'      => $item['llmMetadata']['year'] ?? null,
                'cited_url' => is_string($citedUrl) && $citedUrl !== '' ? $citedUrl : null,
            ];
        }

        if (empty($braveQueries)) {
            return;
        }

        Log::info('Wave 8: Brave Search', ['count' => count($braveQueries)]);
        $braveSearch = app(BraveSearchService::class);
        $stubs = $braveSearch->searchAndFetchBatch($braveQueries, $ctx->db);

        // The service records every decision it made — the query sent, each candidate refused
        // and WHY (host_differs_from_cited_url is the hamiltonfinancialplanning.com refusal made
        // visible), what was chosen and how the fetch graded. Into waveResults so the tracer
        // carries it onto the citation's row; this wave used to throw all of it away.
        foreach ($braveSearch->lastBatchDecisions() as $refId => $decision) {
            if (isset($ctx->pool[$refId])) {
                $ctx->waveResults[$refId]['brave'] = $decision;
            }
        }

        foreach ($stubs as $refId => $stubBookId) {
            if (!isset($ctx->pool[$refId])) {
                continue;
            }
            $result = $ctx->host->resolveWithStub($ctx->pool[$refId], $stubBookId, 'brave_search', $ctx->db);
            $result['url_flags'] = $ctx->pool[$refId]['llmMetadata']['url_flags'] ?? null;
            $ctx->recordResult($result);
            $ctx->host->removeRelatedPoolEntries($ctx->pool, $refId, $ctx->db, $stubBookId);
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 8';
    }

    public function edges(): array
    {
        return [['to' => 'host_cooldown', 'label' => 'accepted hits are fetched through the acquisition ladder']];
    }

}
