<?php

namespace App\Services\CitationPipeline\Resolution;

/**
 * Optional per-citation applicability for a wave.
 *
 * The tracer derives outcomes structurally (resolved / retired / still pooled), which is right
 * for waves that consider every pool entry — but a wave keyed on something only SOME citations
 * carry (a printed DOI, a printed URL, a parked match) used to stamp its batch outcome on every
 * citation anyway. deloitte c14 prints no DOI and its rail still read "Read the printed DOI —
 * routed / That DOI in the local library — no match / That DOI at OpenAlex — skipped: at least
 * one citation prints a DOI the local library did not hold": three steps about an identifier
 * the citation never had, with a skip reason that was a fact about OTHER citations in the batch.
 *
 * A wave that implements this tells the tracer, per item, why THIS item never qualified; the
 * tracer records `skipped` with that reason instead of the structural routed/no_match (and
 * prefers it to the batch entry gate on a wave-level skip). Return null for an item the wave
 * genuinely considered — a real lookup that found nothing must still read `no_match`.
 */
interface PerItemGate
{
    public function itemSkipReason(string $refId, array $item, ResolutionContext $ctx): ?string;
}
