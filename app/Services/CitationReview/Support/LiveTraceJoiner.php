<?php

namespace App\Services\CitationReview\Support;

use Illuminate\Support\Facades\DB;

/**
 * Join the LIVE rows' per-wave traces onto a frozen claims set.
 *
 * A claims file is frozen at REVIEW time, but the trace describes the SCAN — which is free to
 * re-run — so a review made before per-wave tracing landed (2026-09-27) can still show the real
 * path: re-scan the book (free) and the live rows carry it. The claim's own trace always wins
 * when present (it describes the scan the review actually used); the live trace only fills the
 * gap where the snapshot has none, which CitationPath would otherwise render as "not recorded".
 *
 * ONE implementation on purpose: the workbench and the report both join this way, and the two
 * surfaces disagreeing about whether a path was recorded is worse than neither knowing it.
 */
final class LiveTraceJoiner
{
    /**
     * @return array<string, array> refId => trace record ({steps, subs}) from the live rows
     */
    public function forBook(string $bookId): array
    {
        $out = [];
        foreach (['footnotes' => 'footnoteId', 'bibliography' => 'referenceId'] as $table => $idColumn) {
            try {
                $rows = DB::connection('pgsql_admin')->table($table)
                    ->where('book', $bookId)
                    ->whereNotNull('match_diagnostics')
                    ->get([$idColumn, 'match_diagnostics']);
            } catch (\Throwable) {
                continue;
            }

            foreach ($rows as $row) {
                $diag = json_decode((string) $row->match_diagnostics, true);
                if (is_array($diag) && !empty($diag['trace'])) {
                    $out[$row->{$idColumn}] = $diag['trace'];
                }
            }
        }

        return $out;
    }

    /**
     * Fill each claim's missing trace from the live map. Claims that already carry one are left
     * alone — their trace describes the scan the review actually judged against.
     *
     * @param list<array<string, mixed>> $claims
     * @param array<string, array>       $liveTraces refId => trace
     * @return list<array<string, mixed>>
     */
    public function merge(array $claims, array $liveTraces): array
    {
        foreach ($claims as &$claim) {
            $refId = $claim['referenceId'] ?? null;
            if ($refId === null || !isset($liveTraces[$refId])) {
                continue;
            }
            if (!empty($claim['match_diagnostics']['trace'])) {
                continue;
            }
            $claim['match_diagnostics'] = (array) ($claim['match_diagnostics'] ?? []);
            $claim['match_diagnostics']['trace'] = $liveTraces[$refId];
        }

        return $claims;
    }
}
