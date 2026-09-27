<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use App\Services\CitationReview\Support\SourceWorkMismatch;
use Illuminate\Support\Facades\Log;

/**
 * Local library DOI lookup (old Wave 2a) — the cheapest identifier match there is.
 *
 * Builds `ctx->doisToLookup` from the DOIs DoiFromText stamped, matches them against the local
 * `library` table in one query, and DRAINS what it matched — whatever remains in that map is
 * exactly what OpenAlexDoiLookup asks the network about. That fill-then-drain handoff is the
 * contract between the three DOI waves.
 *
 * Two hard-won behaviours preserved verbatim:
 * - `match_method = 'local_doi'` is PERSISTED, not just reported: this wave once wrote its
 *   columns without it, so a local-DOI resolution reached the claim with match_method NULL and
 *   was invisible as a DOI match to the workbench, the report and the identity check.
 * - The DOI settles WHICH work, but if the record it names describes something other than the
 *   citation, `SourceWorkMismatch` declares the divergence (`doi_mismatch` in diagnostics)
 *   instead of resolving silently through it. Measured: peer-review-2027-pdf resolves
 *   "Scientists split on ethics of AI use" to a different Nature article this way.
 */
class LocalDoiLookup implements ResolutionWave
{
    public function id(): string
    {
        return 'local_doi_lookup';
    }

    public function title(): string
    {
        return 'That DOI in the local library';
    }

    public function plain(): string
    {
        return 'We checked whether a work with that DOI is already in the library here — a match '
            . 'links the citation to a readable copy at no cost.';
    }

    public function dev(): string
    {
        return 'One whereIn over library.doi; match writes source/foundation columns + '
            . 'match_method local_doi via updateSourceEntry, carries the row\'s canonical link, '
            . 'and declares doi_mismatch via SourceWorkMismatch when the record disagrees with '
            . 'the citation. Drains doisToLookup; the remainder goes to OpenAlex.';
    }

    public function entryGate(): string
    {
        return 'At least one pool entry carries a DOI.';
    }

    public function acceptGate(): string
    {
        return 'A library row with exactly that DOI. No score — an identifier is not a guess.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        $ctx->doisToLookup = [];
        foreach ($ctx->pool as $refId => $item) {
            if ($item['doi']) {
                $ctx->doisToLookup[$refId] = $item['doi'];
            }
        }

        if (empty($ctx->doisToLookup)) {
            return;
        }

        Log::info('Wave 2a: Local DOI lookup', ['count' => count($ctx->doisToLookup)]);
        $localDoiMatches = $ctx->db->table('library')
            ->whereIn('doi', array_values($ctx->doisToLookup))
            // `year` rides along for the doi_mismatch flag — the divergence is most legible as
            // "cited 2008, record says 2024", and without it the flag would always report a
            // null record year.
            ->get(['book', 'title', 'year', 'doi', 'openalex_id', 'open_library_key', 'canonical_source_id'])
            ->keyBy('doi');

        foreach ($ctx->doisToLookup as $refId => $doi) {
            if (!isset($ctx->pool[$refId])) {
                continue;
            }
            $match = $localDoiMatches->get($doi);
            if (!$match) {
                continue;
            }

            $item = $ctx->pool[$refId];
            $updateData = $item['isLinked']
                ? ['foundation_source' => $match->book, 'match_method' => 'local_doi']
                : ['source_id' => $match->book, 'foundation_source' => $match->book,
                   'match_method' => 'local_doi'];
            // Carry the matched row's existing canonical link through
            $updateData = array_merge($updateData, $ctx->host->canonicalColumnFor($match->canonical_source_id));

            // Same declaration Wave 2b makes: the DOI settles WHICH work, but if the record it
            // names describes something other than the citation, say so. This wave writes its
            // columns directly, so it never reaches the check in resolveWithNormalised().
            $doiDivergence = SourceWorkMismatch::compare(
                $item['llmMetadata']['title'] ?? null,
                $match->title ?? null,
                isset($item['llmMetadata']['year']) ? (int) $item['llmMetadata']['year'] : null,
                isset($match->year) && $match->year !== null ? (int) $match->year : null,
            );
            if ($doiDivergence !== null) {
                $updateData['match_diagnostics'] = json_encode(['doi_mismatch' => $doiDivergence]);
                Log::warning('Local DOI record describes a different work than the citation', [
                    'refId' => $refId, 'book' => $match->book,
                ] + $doiDivergence);
            }

            $ctx->host->updateSourceEntry($ctx->db, $refId, $updateData);

            $ctx->recordResult([
                'referenceId'         => $refId,
                'status'              => $item['isLinked'] ? 'enriched' : 'newly_resolved',
                'match_method'        => 'local_doi',
                'searched_title'      => $item['searchedTitle'],
                'result_title'        => $match->title,
                'openalex_id'         => $match->openalex_id,
                'open_library_key'    => $match->open_library_key,
                'foundation_book_id'  => $match->book,
                'canonical_source_id' => $match->canonical_source_id,
                'llm_metadata'        => $item['llmMetadata'],
            ]);
            $ctx->host->removeRelatedPoolEntries($ctx->pool, $refId, $ctx->db, $match->book);
            unset($ctx->doisToLookup[$refId]);
        }

        Log::info('Wave 2a: Local DOI matches', [
            'found'     => $localDoiMatches->count(),
            'remaining' => count($ctx->doisToLookup),
        ]);
    }
    public function logMarker(): ?string
    {
        return 'Wave 2a';
    }

    public function edges(): array
    {
        return [];
    }

}
