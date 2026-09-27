<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use Illuminate\Support\Facades\Log;

/**
 * Wave 2b — ask OpenAlex about the DOIs the local library did not already hold.
 *
 * Wave 2a drains `$doisToLookup` as it matches locally, so whatever is left here is exactly the
 * set of citations that print a DOI we have never seen. That ordering is the point: a DOI we
 * already hold costs a database query, and this wave costs an HTTP round trip.
 *
 * A DOI settles WHICH work is meant, so `resolveWithNormalised` skips the title-search gates for
 * it — but "which work" and "is that the work the author described" are different questions, and
 * that method declares the disagreement rather than resolving through it. Nothing in this wave
 * second-guesses the identifier.
 *
 * FIRST WAVE EXTRACTED (2026-09-26), chosen for being the smallest — if the scaffolding is wrong,
 * `citation:ladder:golden --verify` says so against 132 real decisions before eleven more waves
 * are built on top of it.
 */
class OpenAlexDoiLookup implements ResolutionWave
{
    public function id(): string
    {
        return 'openalex_doi_lookup';
    }

    public function title(): string
    {
        return 'That DOI at OpenAlex';
    }

    public function plain(): string
    {
        return 'The citation printed a DOI — a permanent identifier for a specific work — and we '
            . 'had no copy of it, so we asked OpenAlex, a public index of scholarly works, which '
            . 'work that DOI belongs to.';
    }

    public function dev(): string
    {
        return 'Batch `fetchByDoiBatch` over the DOIs the local lookup left unmatched, keyed by '
            . 'refId. Resolves via resolveWithNormalised with match_method `doi`, which skips the '
            . 'title gates but still records a SourceWorkMismatch when the named record describes '
            . 'something other than the citation.';
    }

    public function entryGate(): string
    {
        return 'At least one citation prints a DOI that the local library did not hold.';
    }

    public function acceptGate(): string
    {
        return 'OpenAlex returns a work for the DOI. No score threshold — an identifier is not a guess.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->doisToLookup !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        Log::info('Wave 2b: OpenAlex DOI lookup', ['count' => count($ctx->doisToLookup)]);

        foreach ($ctx->openAlex->fetchByDoiBatch($ctx->doisToLookup) as $refId => $normalised) {
            // The pool check is not redundant with the loop: resolving one entry can remove
            // SIBLINGS (a sub-citation's parent, a duplicate of the same work), so an id that was
            // present when the batch was issued may already be claimed by the time we reach it.
            if (!$normalised || !isset($ctx->pool[$refId])) {
                continue;
            }

            $result = $ctx->host->resolveWithNormalised(
                $ctx->pool[$refId],
                $normalised,
                'doi',
                null,
                $ctx->openAlex,
                $ctx->db,
            );

            if (!$result) {
                continue;
            }

            $ctx->recordResult($result);
            $ctx->host->removeRelatedPoolEntries($ctx->pool, $refId, $ctx->db, $result['foundation_book_id'] ?? null);
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 2b';
    }

    public function edges(): array
    {
        return [];
    }

}
