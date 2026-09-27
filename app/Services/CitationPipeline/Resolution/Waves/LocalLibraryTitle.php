<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use Illuminate\Support\Facades\Log;

/**
 * Local library title search (old Wave 3) — the docuverse asked before the internet is.
 *
 * A work already in the library is the BEST possible resolution: it links the citation to a
 * readable book instead of a stub, costs a database query, and every earlier review of that
 * work compounds. So this runs before any external index.
 *
 * The one behaviour that is not obvious: URL-FIRST DEFERRAL. When the citation PRINTS a URL,
 * a library title match is PARKED rather than applied (`deferLibraryMatchForPrintedUrl`) —
 * the printed address is the author's own testimony about where the work lives, and the
 * printed-URL wave gets first refusal. The parked match cannot be lost: it is applied before
 * any search money is spent if the URL yields nothing carrying article text. This is the same
 * rule that stopped a title search overruling a printed URL (the
 * hamiltonfinancialplanning.com swap).
 *
 * Unlike the search waves this writes its columns via `updateSourceEntry` directly rather than
 * through `resolveWithNormalised` — a library match needs no external normalisation and carries
 * its canonical link straight off the matched row.
 */
class LocalLibraryTitle implements ResolutionWave
{
    public function id(): string
    {
        return 'local_library_title';
    }

    public function title(): string
    {
        return 'Local library title search';
    }

    public function plain(): string
    {
        return 'Before searching the internet, we checked whether the cited work is already in '
            . 'the library here — a match links the citation to a readable copy directly.';
    }

    public function dev(): string
    {
        return 'searchLibraryTable (fuzzy title + metadata) per unresolved entry. A match on a '
            . 'citation that PRINTS a URL is parked via deferLibraryMatchForPrintedUrl so the '
            . 'printed-URL wave gets first refusal. Writes match_method `library` via '
            . 'updateSourceEntry; near-misses recorded.';
    }

    public function entryGate(): string
    {
        return 'Unresolved pool entries with a searchable title.';
    }

    public function acceptGate(): string
    {
        return 'searchLibraryTable\'s own similarity bar; a printed URL defers the match instead '
            . 'of applying it.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        Log::info('Wave 3: Library table search', ['remaining' => count($ctx->pool)]);

        foreach ($ctx->pool as $refId => $item) {
            if (!$item['searchedTitle']) {
                continue;
            }
            $localNearMiss = null;
            $localMatch = $ctx->host->searchLibraryTable($item['searchedTitle'], $item['llmMetadata'], $ctx->openAlex, $ctx->db, $localNearMiss);
            if ($localMatch) {
                if ($ctx->host->deferLibraryMatchForPrintedUrl($refId, $item, $localMatch)) {
                    continue;
                }
                $diagJson = !empty($localMatch['diagnostics']) ? json_encode($localMatch['diagnostics']) : null;
                $updateData = $item['isLinked']
                    ? ['foundation_source' => $localMatch['book'], 'match_method' => 'library', 'match_score' => $localMatch['score'], 'match_diagnostics' => $diagJson]
                    : ['source_id' => $localMatch['book'], 'foundation_source' => $localMatch['book'], 'match_method' => 'library', 'match_score' => $localMatch['score'], 'match_diagnostics' => $diagJson];
                // Carry the matched row's existing canonical link through
                $updateData = array_merge($updateData, $ctx->host->canonicalColumnFor($localMatch['canonical_source_id'] ?? null));

                $ctx->host->updateSourceEntry($ctx->db, $refId, $updateData);

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
            } elseif ($localNearMiss && $localNearMiss['score'] > ($ctx->nearMisses[$refId]['score'] ?? 0.0)) {
                $ctx->nearMisses[$refId] = $localNearMiss;
            }
        }
    }
    public function logMarker(): ?string
    {
        return 'Wave 3';
    }

    public function edges(): array
    {
        return [['to' => 'url_first_fallback', 'label' => 'match parked for the printed URL — the fallback applies it if the URL does not win']];
    }

}
