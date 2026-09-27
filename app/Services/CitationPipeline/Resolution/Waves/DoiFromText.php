<?php

namespace App\Services\CitationPipeline\Resolution\Waves;

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
class DoiFromText implements ResolutionWave
{
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
        return 'openAlex.extractDoi(content) per pool item, then llmMetadata.doi as fallback '
            . 'where the regex found nothing. Regex first: it reads the printed characters, the '
            . 'LLM can normalise or invent. Routes only — the lookups are the next two waves.';
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
            $item['doi'] = $ctx->openAlex->extractDoi($item['content']);
        }
        unset($item);

        // Merge LLM-extracted DOIs for entries where regex found nothing
        foreach ($ctx->pool as $refId => &$item) {
            if (!$item['doi'] && !empty($item['llmMetadata']['doi'])) {
                $item['doi'] = $item['llmMetadata']['doi'];
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
