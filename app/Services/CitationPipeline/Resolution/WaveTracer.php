<?php

namespace App\Services\CitationPipeline\Resolution;

/**
 * The per-citation trace, recorded STRUCTURALLY around every wave.
 *
 * Before this, whether a wave left evidence was that wave's own habit: `match_diagnostics` had
 * three mutually exclusive shapes (a scoring breakdown, a near-miss envelope, or nothing at
 * all), `wave_results` was discarded whenever a near-miss existed, and five waves recorded
 * nothing ever — so "ran and found nothing" was indistinguishable from "never reached", and
 * every why-didn't-this-resolve question cost a database console session. Because the tracer
 * wraps the RUNNER rather than living inside the waves, a wave that does not trace is
 * unrepresentable — a new wave is traced before its author has thought about tracing.
 *
 * The step vocabulary is the wave's `id()` — the same ids `ResolutionLadderMap` publishes and
 * the reader-facing path renders, which is why they are functional and permanent (see
 * ResolutionWave's naming rule).
 *
 * HOW OUTCOMES ARE DERIVED, rather than reported: the tracer diffs context state around
 * `run()`. A refId that gained a `$results` row was resolved here (the row's own status and
 * score are the truth); one that left the pool WITHOUT a row was retired as a relative (its
 * parent or sibling resolved); one still in the pool was not matched. Per-refId detail is the
 * diff of `waveResults[refId]` across the wave — whatever the wave chose to record (best score,
 * fetch outcome, the Brave decision) rides along without the tracer knowing any wave's schema.
 */
class WaveTracer
{
    public function __construct(private ResolutionContext $ctx)
    {
    }

    public function runTraced(ResolutionWave $wave): void
    {
        $ctx = $this->ctx;

        if (!$wave->shouldRun($ctx)) {
            // A wave-level skip still gets a step per pooled citation: "Brave was never asked
            // because no API key is configured" is a fact about the review the reader is owed,
            // and it is precisely the kind that used to be invisible.
            foreach (array_keys($ctx->pool) as $refId) {
                $ctx->trace[$refId][] = [
                    'stage'   => $wave->id(),
                    'outcome' => 'skipped',
                    'reason'  => $wave->entryGate(),
                ];
            }

            return;
        }

        $poolBefore = array_keys($ctx->pool);
        $resultsBefore = count($ctx->results);
        $waveResultsBefore = $ctx->waveResults; // copy-on-write; cheap until a wave writes

        $wave->run($ctx);

        $resolvedBy = [];
        foreach (array_slice($ctx->results, $resultsBefore) as $row) {
            $resolvedBy[$row['referenceId']] = $row;
        }

        // A wave whose accept gate opens with "None" cannot match — it routes or extracts, and
        // calling its pass-through "no_match" would read as fourteen failures on every citation.
        $routesOnly = str_starts_with($wave->acceptGate(), 'None');

        foreach ($poolBefore as $refId) {
            $step = ['stage' => $wave->id()];

            if (isset($resolvedBy[$refId])) {
                $row = $resolvedBy[$refId];
                $step['outcome'] = (string) ($row['status'] ?? 'resolved');
                if (!empty($row['match_method'])) {
                    $step['method'] = $row['match_method'];
                }
                $score = $row['similarity_score'] ?? $row['match_score'] ?? $row['score'] ?? null;
                if ($score !== null) {
                    $step['score'] = round((float) $score, 3);
                }
            } elseif (!isset($ctx->pool[$refId])) {
                // Removed without a result row of its own: its parent or a sibling resolved
                // and removeRelatedPoolEntries retired the whole family.
                $step['outcome'] = 'retired_with_relative';
            } else {
                $step['outcome'] = $routesOnly ? 'routed' : 'no_match';
            }

            $detail = $this->waveResultsDelta($waveResultsBefore[$refId] ?? [], $ctx->waveResults[$refId] ?? []);
            if ($detail !== []) {
                $step['detail'] = $detail;
            }

            $ctx->trace[$refId][] = $step;
        }
    }

    /** What this wave ADDED to a citation's waveResults — its own recorded evidence, schema unknown. */
    private function waveResultsDelta(array $before, array $after): array
    {
        $delta = [];
        foreach ($after as $key => $value) {
            if (!array_key_exists($key, $before) || $before[$key] !== $value) {
                $delta[$key] = $value;
            }
        }

        return $delta;
    }
}
