<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

use App\Services\CitationPipeline\Resolution\PerItemGate;
use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionWave;

/**
 * DOI extraction (old Wave 1) — pure routing, resolves nothing itself.
 *
 * A printed DOI is the strongest identity signal a citation can carry, so it is read FIRST:
 * a regex over the citation's own text, then the LLM-extracted DOI as a fallback where the
 * regex found nothing. Regex first deliberately — it reads the characters that are actually
 * printed, where the LLM can normalise or hallucinate one; the merge order encodes that trust.
 *
 * Stamps `doi` on every pool item; the two DOI lookup waves read it from there.
 */
class DoiFromText implements ResolutionWave, PerItemGate
{
    /**
     * Evaluated AFTER run() stamped `doi`, so this is "we looked and the citation prints none"
     * — rendered as a skip because 'routed' on a DOI-less citation reads as a found identifier.
     */
    public function itemSkipReason(string $refId, array $item, ResolutionContext $ctx): ?string
    {
        if (!empty($item['doi'])) {
            return null;
        }
        // A multi-work footnote can print a DOI that is another work's: say so, or the
        // reader wonders why a DOI they can see on the page reads "prints no DOI".
        return empty($item['doi_unattributable'])
            ? 'The citation prints no DOI.'
            : 'The footnote prints a DOI, but it could not be attributed to THIS work.';
    }

    public function id(): string
    {
        return 'doi_from_text';
    }

    public function title(): string
    {
        return 'Read the printed DOI';
    }

    public function plain(): string
    {
        return 'If the citation prints a DOI — a permanent identifier for a specific work — we '
            . 'read it directly from the citation\'s own text.';
    }

    public function dev(): string
    {
        return 'CitedDoi::printed per pool item — multi-work aware: a ::subN item and a '
            . 'multi-work parent use ONLY their own work\'s llmMetadata.doi (the footnote text '
            . 'cannot say which printed DOI is whose); a single-work entry keeps '
            . 'extractDoi(content) first (it reads the printed characters, the LLM can normalise '
            . 'or invent) with llmMetadata.doi as fallback. Routes only — the lookups are the '
            . 'next two waves.';
    }

    public function entryGate(): string
    {
        return 'Every pool entry — extraction is free.';
    }

    public function acceptGate(): string
    {
        return 'None — routes only; a found DOI feeds the local and OpenAlex DOI lookups.';
    }

    public function shouldRun(ResolutionContext $ctx): bool
    {
        return $ctx->pool !== [];
    }

    public function run(ResolutionContext $ctx): void
    {
        foreach ($ctx->pool as $refId => &$item) {
            // ONE derivation, multi-work aware (deloitte c58: the content regex stamped
            // work 2's DOI on work 1, which then "resolved" to the wrong book) — a sub or
            // multi-work parent takes only its OWN work's llm doi; single-work keeps the
            // historical content-regex-first order. See CitedDoi.
            $item['doi'] = \App\Services\CitationPipeline\Resolution\CitedDoi::printed($item, $ctx->openAlex);
            if ($item['doi'] === null
                && (!empty($item['parentRefId']) || !empty($item['llmMetadata']['sub_citations']))
                && $ctx->openAlex->extractDoi($item['content'])
            ) {
                // The footnote prints a DOI we refused to attribute — the trace says why.
                $item['doi_unattributable'] = true;
            }
        }
        unset($item);
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
