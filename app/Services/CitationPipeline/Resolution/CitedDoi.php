<?php

namespace App\Services\CitationPipeline\Resolution;

use App\Services\OpenAlexService;

/**
 * THE printed DOI for a pool item — one derivation, multi-work aware.
 *
 * DoiFromText used to regex the item's `content` first for EVERY item — but for a
 * multi-work footnote the content is the WHOLE footnote, so the regex returns the
 * first DOI printed by ANY of its works. deloitte c58: "Panko (2008) Thinking is
 * Bad…; Csernoch et al. (2024) … 10.3390/e26121015" — the LLM had already
 * attributed the DOI correctly (parent Panko: none; sub Csernoch: the Entropy DOI),
 * and the content regex overrode that, stamping Csernoch's DOI on the PANKO item.
 * local_doi then "resolved" Panko's claim to the Csernoch book: SourceWorkMismatch
 * voided the verdict, but Panko's own ladder ended there and the work was never
 * searched at all.
 *
 * Rules (stricter than CitedUrl's, because an identifier is not a guess — a
 * mis-attributed DOI becomes a confidently wrong canonical match, where a wrong
 * URL at worst fetches a page the identity screen rejects):
 * - a SUB ({refId}::subN) uses ONLY its own work's llmMetadata.doi;
 * - a MULTI-WORK PARENT uses ONLY its own work's llmMetadata.doi — no content
 *   fallback, since the content cannot say which work a printed DOI belongs to;
 * - a single-work entry keeps the historical order: content regex first (it reads
 *   the characters actually printed, where the LLM can normalise or invent),
 *   then llmMetadata.doi where the regex found nothing.
 */
class CitedDoi
{
    public static function printed(array $item, OpenAlexService $openAlex): ?string
    {
        $llmDoi = $item['llmMetadata']['doi'] ?? null;
        $llmDoi = is_string($llmDoi) && trim($llmDoi) !== '' ? trim($llmDoi) : null;

        $isSub = !empty($item['parentRefId']);
        $isMultiParent = !$isSub && !empty($item['llmMetadata']['sub_citations']);
        if ($isSub || $isMultiParent) {
            return $llmDoi;
        }

        return $openAlex->extractDoi((string) ($item['content'] ?? '')) ?: $llmDoi;
    }
}
