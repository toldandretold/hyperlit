<?php

namespace App\Services\CitationStudy;

/**
 * Pure merge of a single citation's fresh claim rows into a base run's claims
 * array. IO-free so the splice semantics are trivially testable.
 *
 * A row "belongs" to the target referenceId when it IS that refId or a
 * multi-work sibling of it ({refId}::subN — matched on '::' so any future
 * sub-key scheme is still caught). The boundary matters: 'smith2020' must not
 * claim 'smith2020b'.
 */
class ClaimsPatcher
{
    /**
     * @param array $baseClaims the base run's full claims list
     * @param array $freshClaims the single-citation review's claims (all rows
     *   must carry the target refId or a ::sub sibling of it)
     * @param string $referenceId the parent referenceId being patched
     * @return array{claims: array, replaced: int, inserted: int}
     */
    public function patch(array $baseClaims, array $freshClaims, string $referenceId): array
    {
        foreach ($freshClaims as $row) {
            $refId = $row['referenceId'] ?? null;
            if (!is_string($refId) || !$this->belongs($refId, $referenceId)) {
                throw new \InvalidArgumentException(
                    'Fresh claim row carries foreign referenceId '
                    . var_export($refId, true) . " — expected {$referenceId} or {$referenceId}::subN."
                );
            }
        }

        // Remove every base row belonging to the target, remembering where the
        // FIRST one sat so the fresh rows splice back in document order.
        $kept = [];
        $spliceAt = null;
        $replaced = 0;
        foreach (array_values($baseClaims) as $row) {
            $refId = $row['referenceId'] ?? null;
            if (is_string($refId) && $this->belongs($refId, $referenceId)) {
                $spliceAt ??= count($kept);
                $replaced++;
                continue;
            }
            $kept[] = $row;
        }

        // The orphan-gt case: the citation never produced a claim in the base
        // run, so there is no position to preserve — append.
        $spliceAt ??= count($kept);
        array_splice($kept, $spliceAt, 0, array_values($freshClaims));

        return [
            'claims' => $kept,
            'replaced' => $replaced,
            'inserted' => count($freshClaims),
        ];
    }

    private function belongs(string $refId, string $target): bool
    {
        return $refId === $target || str_starts_with($refId, $target . '::');
    }
}
