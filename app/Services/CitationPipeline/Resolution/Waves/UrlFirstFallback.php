<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;

/**
 * The URL-first fallback — apply the matches earlier waves PARKED, now that the printed URL has
 * been assessed.
 *
 * A ref still in the pool here means its URL did not yield the source (dead, blocked, a
 * different work) — so the parked title-search or library match is applied. This is the
 * guarantee that makes URL-first deferral safe: it can never LOSE a resolution, it only orders
 * content ahead of a content-free stub. Runs before Brave so no search money is spent on refs
 * that already hold a corroborated match.
 *
 * Two apply paths, matching the two park sites: a parked LIBRARY match re-runs the library
 * write (the book already exists, no stub to mint); a parked NORMALISED match goes back through
 * resolveWithNormalised with `allowUrlDeferral: false` — the one flag stopping it from parking
 * itself again forever.
 */
class UrlFirstFallback implements ResolutionWave
{
    public function id(): string
    {
        return 'url_first_fallback';
    }

    public function title(): string
    {
        return 'Apply the match the printed URL outranked';
    }

    public function plain(): string
    {
        return 'Where the printed address turned out dead, blocked or pointing elsewhere, we '
            . 'fell back to the match we had already found and set aside — deferring to the URL '
            . 'never loses a match, it only tries the author\'s own address first.';
    }

    public function dev(): string
    {
        return 'Consumes urlDeferredLibraryMatches (re-runs the library write) then '
            . 'urlDeferredMatches (resolveWithNormalised with allowUrlDeferral: false). A ref '
            . 'absent from the pool means the URL won. waveResults.url_first names which way it '
            . 'went.';
    }

    public function entryGate(): string
    {
        return 'A match was parked for this citation and the printed-URL fetch did not resolve it.';
    }

    public function acceptGate(): string
    {
        return 'The parked match applies as it originally scored — its gates were already passed.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->host->urlDeferredLibraryMatches() !== []
            || $ctx->host->urlDeferredMatches() !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        // Parked LIBRARY matches first — same contract, different apply path (the book already
        // exists, so this re-runs the library write rather than minting a stub).
        foreach ($ctx->host->urlDeferredLibraryMatches() as $refId => $stash) {
            if (!isset($ctx->pool[$refId])) {
                continue; // the URL won — it carried the article
            }
            $item = $stash['item'];
            $localMatch = $stash['match'];
            $diagJson = !empty($localMatch['diagnostics']) ? json_encode($localMatch['diagnostics']) : null;
            $updateData = $item['isLinked']
                ? ['foundation_source' => $localMatch['book'], 'match_method' => 'library', 'match_score' => $localMatch['score'], 'match_diagnostics' => $diagJson]
                : ['source_id' => $localMatch['book'], 'foundation_source' => $localMatch['book'], 'match_method' => 'library', 'match_score' => $localMatch['score'], 'match_diagnostics' => $diagJson];
            $updateData = array_merge($updateData, $ctx->host->canonicalColumnFor($localMatch['canonical_source_id'] ?? null));
            $ctx->host->updateSourceEntry($ctx->db, $refId, $updateData);

            $ctx->waveResults[$refId]['url_first'] ??= 'url_unusable_fell_back_to_library';
            $ctx->recordResult([
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
            ]);
            $ctx->host->removeRelatedPoolEntries($ctx->pool, $refId, $ctx->db, $localMatch['book']);
        }

        foreach ($ctx->host->urlDeferredMatches() as $refId => $stash) {
            if (!isset($ctx->pool[$refId])) {
                continue; // the URL fetch won — the stub carries actual content
            }
            $result = $ctx->host->resolveWithNormalised(
                $ctx->pool[$refId], $stash['normalised'], $stash['matchMethod'], $stash['score'],
                $ctx->openAlex, $ctx->db, $stash['diagnostics'], allowUrlDeferral: false,
            );
            if ($result) {
                $ctx->waveResults[$refId]['url_first'] = 'url_unusable_fell_back_to_' . $stash['matchMethod'];
                $ctx->recordResult($result);
                $ctx->host->removeRelatedPoolEntries($ctx->pool, $refId, $ctx->db, $result['foundation_book_id'] ?? null);
            }
        }
    }
    public function logMarker(): ?string
    {
        return null;
    }

    public function edges(): array
    {
        return [];
    }

}
