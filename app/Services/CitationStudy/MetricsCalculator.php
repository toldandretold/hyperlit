<?php

namespace App\Services\CitationStudy;

/**
 * Detection metrics over the joined per-citation dataset.
 *
 * The 5-point verdict ladder is treated as ordinal: at each cutoff θ a
 * citation counts as "flagged" when its verdict is θ-or-worse, with the
 * source-not-found channel flagged at every cutoff (it is the tool's other
 * detection channel). 'insufficient' is NOT on the ladder — model failure and
 * no-evidence share that value, so those rows are excluded from the binary
 * confusion matrices and reported as their own class. Ground-truth positives
 * are the injected corruptions; suspect/unverifiable (retracted arm) stay out
 * of the binary and are reported descriptively.
 */
class MetricsCalculator
{
    public const LADDER = ['rejected' => 0, 'unlikely' => 1, 'plausible' => 2, 'likely' => 3, 'confirmed' => 4];
    public const CUTOFFS = ['rejected', 'unlikely', 'plausible', 'likely'];
    public const PRIMARY_CUTOFF = 'unlikely';

    public function summarise(array $rows, array $diagnostics = []): array
    {
        $summary = [
            'n_rows' => count($rows),
            'n_books' => count(array_unique(array_column($rows, 'book_id'))),
            'label_counts' => $this->countBy($rows, 'gt_label'),
            'verdict_counts' => $this->countBy($rows, 'verdict'),
            'verdict_by_label' => $this->crosstab($rows, 'gt_label', 'verdict'),
            'cutoff_metrics' => $this->cutoffMetrics($rows, 'verdict'),
            'cutoff_metrics_pre_upgrade' => $this->cutoffMetrics($rows, 'verdict_pre_upgrade'),
            'upgrades' => $this->upgradeStats($rows),
            'detection_channels' => $this->detectionChannels($rows),
            'breakdowns' => [
                'arm' => $this->breakdown($rows, 'arm'),
                'corruption_type' => $this->breakdown($rows, 'corruption_type'),
                'evidence_type' => $this->breakdown($rows, 'evidence_type'),
                'match_method' => $this->breakdown($rows, 'match_method'),
                'citation_row' => $this->breakdown($rows, 'citation_row'),
            ],
            'descriptive_labels' => $this->descriptive($rows),
            'timing_cost' => $this->timingCost($rows),
            'join_diagnostics' => $diagnostics,
        ];
        return $summary;
    }

    // -------------------------------------------------------------- confusion

    /** @return array cutoff => metrics */
    public function cutoffMetrics(array $rows, string $verdictField): array
    {
        $out = [];
        foreach (self::CUTOFFS as $cutoff) {
            $tp = $fp = $fn = $tn = $excluded = 0;
            foreach ($rows as $row) {
                $isPositive = in_array($row['gt_label'], CorpusManifest::POSITIVE_LABELS, true);
                $isNegative = in_array($row['gt_label'], CorpusManifest::NEGATIVE_LABELS, true);
                if (!$isPositive && !$isNegative) {
                    continue; // suspect/unverifiable — descriptive only
                }
                $flagged = $this->flaggedAt($row[$verdictField] ?? null, $cutoff);
                if ($flagged === null) {
                    $excluded++;
                    continue;
                }
                if ($isPositive) {
                    $flagged ? $tp++ : $fn++;
                } else {
                    $flagged ? $fp++ : $tn++;
                }
            }

            $sens = ($tp + $fn) > 0 ? $tp / ($tp + $fn) : null;
            $spec = ($tn + $fp) > 0 ? $tn / ($tn + $fp) : null;
            $prec = ($tp + $fp) > 0 ? $tp / ($tp + $fp) : null;
            $f1 = ($prec !== null && $sens !== null && ($prec + $sens) > 0)
                ? 2 * $prec * $sens / ($prec + $sens)
                : null;

            $out[$cutoff] = [
                'tp' => $tp, 'fp' => $fp, 'fn' => $fn, 'tn' => $tn,
                'excluded_insufficient' => $excluded,
                'sensitivity' => $this->round($sens),
                'sensitivity_ci95' => $sens !== null ? $this->wilson($tp, $tp + $fn) : null,
                'specificity' => $this->round($spec),
                'specificity_ci95' => $spec !== null ? $this->wilson($tn, $tn + $fp) : null,
                'precision' => $this->round($prec),
                'f1' => $this->round($f1),
            ];
        }
        return $out;
    }

    /**
     * Flagged at cutoff? true/false, or null when the row is excluded from
     * the binary (insufficient — model failure and no-evidence are
     * indistinguishable in the verdict field).
     */
    public function flaggedAt(?string $verdict, string $cutoff): ?bool
    {
        if ($verdict === 'source_not_found') {
            return true;
        }
        if ($verdict === 'not_detected_missing') {
            return false;
        }
        if ($verdict === null || $verdict === 'insufficient' || !isset(self::LADDER[$verdict])) {
            return null;
        }
        return self::LADDER[$verdict] <= self::LADDER[$cutoff];
    }

    /**
     * Cohen's kappa for two verdict sequences (chance-corrected agreement).
     * Returns null when undefined (empty input, or chance agreement = 1).
     */
    public function cohenKappa(array $a, array $b): ?float
    {
        $n = min(count($a), count($b));
        if ($n === 0) {
            return null;
        }
        $agree = 0;
        $countsA = [];
        $countsB = [];
        for ($i = 0; $i < $n; $i++) {
            if ($a[$i] === $b[$i]) {
                $agree++;
            }
            $countsA[$a[$i]] = ($countsA[$a[$i]] ?? 0) + 1;
            $countsB[$b[$i]] = ($countsB[$b[$i]] ?? 0) + 1;
        }
        $po = $agree / $n;
        $pe = 0.0;
        foreach ($countsA as $cat => $ca) {
            $pe += ($ca / $n) * (($countsB[$cat] ?? 0) / $n);
        }
        if (abs(1 - $pe) < 1e-9) {
            return null;
        }
        return $this->round(($po - $pe) / (1 - $pe));
    }

    /** Wilson 95% interval as [lo, hi]. */
    public function wilson(int $successes, int $n): ?array
    {
        if ($n === 0) {
            return null;
        }
        $z = 1.959963985;
        $p = $successes / $n;
        $z2 = $z * $z;
        $denom = 1 + $z2 / $n;
        $centre = ($p + $z2 / (2 * $n)) / $denom;
        $half = ($z * sqrt(($p * (1 - $p) + $z2 / (4 * $n)) / $n)) / $denom;
        return [$this->round(max(0.0, $centre - $half)), $this->round(min(1.0, $centre + $half))];
    }

    // ------------------------------------------------------------- breakdowns

    /** Sensitivity/FPR at the primary cutoff per value of a dimension. */
    private function breakdown(array $rows, string $dimension): array
    {
        $groups = [];
        foreach ($rows as $row) {
            $key = $row[$dimension] ?? 'null';
            $groups[$key][] = $row;
        }
        ksort($groups);

        $out = [];
        foreach ($groups as $value => $groupRows) {
            $metrics = $this->cutoffMetrics($groupRows, 'verdict')[self::PRIMARY_CUTOFF];
            $out[$value] = [
                'n' => count($groupRows),
                'positives' => $metrics['tp'] + $metrics['fn'],
                'negatives' => $metrics['tn'] + $metrics['fp'],
                'sensitivity' => $metrics['sensitivity'],
                'false_positive_rate' => ($metrics['fp'] + $metrics['tn']) > 0
                    ? $this->round($metrics['fp'] / ($metrics['fp'] + $metrics['tn']))
                    : null,
            ];
        }
        return $out;
    }

    /** Which channel caught each true positive at the primary cutoff. */
    private function detectionChannels(array $rows): array
    {
        $channels = ['source_not_found' => 0, 'verdict' => 0, 'missed' => 0, 'excluded_insufficient' => 0];
        foreach ($rows as $row) {
            if (!in_array($row['gt_label'], CorpusManifest::POSITIVE_LABELS, true)) {
                continue;
            }
            $verdict = $row['verdict'] ?? null;
            if ($verdict === 'source_not_found') {
                $channels['source_not_found']++;
            } elseif ($verdict === 'insufficient') {
                $channels['excluded_insufficient']++;
            } elseif ($this->flaggedAt($verdict, self::PRIMARY_CUTOFF) === true) {
                $channels['verdict']++;
            } else {
                $channels['missed']++;
            }
        }
        return $channels;
    }

    private function upgradeStats(array $rows): array
    {
        $byLabel = [];
        $total = 0;
        foreach ($rows as $row) {
            if (!empty($row['was_upgraded'])) {
                $total++;
                $byLabel[$row['gt_label']] = ($byLabel[$row['gt_label']] ?? 0) + 1;
            }
        }
        ksort($byLabel);
        return ['total' => $total, 'by_label' => $byLabel];
    }

    private function descriptive(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $label = $row['gt_label'];
            if (in_array($label, CorpusManifest::POSITIVE_LABELS, true)
                || in_array($label, CorpusManifest::NEGATIVE_LABELS, true)
            ) {
                continue;
            }
            $out[$label][$row['verdict'] ?? 'null'] = ($out[$label][$row['verdict'] ?? 'null'] ?? 0) + 1;
        }
        return $out;
    }

    // ------------------------------------------------------------ timing/cost

    private function timingCost(array $rows): array
    {
        $books = [];
        foreach ($rows as $row) {
            $books[$row['book_id']] = $row;
        }

        $review = $this->numbers($books, 'book_review_seconds');
        $total = $this->numbers($books, 'book_total_seconds');
        $wall = $this->numbers($books, 'book_wall_seconds');
        $cost = $this->numbers($books, 'book_cost_usd');
        $perCitation = $this->numbers($books, 'cost_per_citation');

        return [
            'books' => count($books),
            'review_seconds' => $this->stats($review),
            'pipeline_seconds' => $this->stats($total),
            'wall_seconds' => $this->stats($wall),
            'cost_usd' => $this->stats($cost) + ['total' => $this->round(array_sum($cost))],
            'cost_per_citation_usd' => $this->stats($perCitation),
            'books_missing_billing' => count(array_filter($books, fn ($b) => ($b['book_cost_usd'] ?? null) === null)),
        ];
    }

    private function numbers(array $books, string $field): array
    {
        return array_values(array_filter(
            array_map(fn ($b) => $b[$field] ?? null, $books),
            fn ($v) => $v !== null
        ));
    }

    private function stats(array $values): array
    {
        if ($values === []) {
            return ['n' => 0, 'median' => null, 'mean' => null, 'min' => null, 'max' => null];
        }
        sort($values);
        $n = count($values);
        $median = $n % 2 === 1
            ? $values[intdiv($n, 2)]
            : ($values[$n / 2 - 1] + $values[$n / 2]) / 2;
        return [
            'n' => $n,
            'median' => $this->round($median),
            'mean' => $this->round(array_sum($values) / $n),
            'min' => $this->round($values[0]),
            'max' => $this->round($values[$n - 1]),
        ];
    }

    // ------------------------------------------------------------------ utils

    private function countBy(array $rows, string $field): array
    {
        $out = [];
        foreach ($rows as $row) {
            $key = $row[$field] ?? 'null';
            $out[$key] = ($out[$key] ?? 0) + 1;
        }
        ksort($out);
        return $out;
    }

    private function crosstab(array $rows, string $rowField, string $colField): array
    {
        $out = [];
        foreach ($rows as $row) {
            $r = $row[$rowField] ?? 'null';
            $c = $row[$colField] ?? 'null';
            $out[$r][$c] = ($out[$r][$c] ?? 0) + 1;
        }
        ksort($out);
        foreach ($out as &$cols) {
            ksort($cols);
        }
        return $out;
    }

    private function round(?float $value): ?float
    {
        return $value === null ? null : round($value, 4);
    }

    // ------------------------------------------------------------- summary.md

    public function toMarkdown(array $summary, string $corpus, ?string $runId): string
    {
        $lines = [];
        $lines[] = "# Citation study summary — corpus `{$corpus}`" . ($runId ? " (run `{$runId}`)" : '');
        $lines[] = '';
        $lines[] = "Dataset: {$summary['n_rows']} citation rows across {$summary['n_books']} books.";
        $lines[] = '';

        $lines[] = '## Ground-truth labels';
        foreach ($summary['label_counts'] as $label => $count) {
            $lines[] = "- **{$label}** — {$count}";
        }
        $lines[] = '';

        $lines[] = '## Verdict distribution by ground-truth label';
        foreach ($summary['verdict_by_label'] as $label => $verdicts) {
            $parts = [];
            foreach ($verdicts as $verdict => $count) {
                $parts[] = "{$verdict}: {$count}";
            }
            $lines[] = "- **{$label}** — " . implode(', ', $parts);
        }
        $lines[] = '';

        foreach ([
            'cutoff_metrics' => '## Detection metrics per verdict cutoff (post rejection-upgrade)',
            'cutoff_metrics_pre_upgrade' => '## Detection metrics per verdict cutoff (pre rejection-upgrade)',
        ] as $key => $heading) {
            $lines[] = $heading;
            $lines[] = 'A citation counts as flagged when its verdict is at the cutoff or worse; "source not found" flags at every cutoff; `insufficient` rows are excluded (model failure and no-evidence are indistinguishable).';
            foreach ($summary[$key] as $cutoff => $m) {
                $ciS = $m['sensitivity_ci95'] ? " (95% CI {$m['sensitivity_ci95'][0]}–{$m['sensitivity_ci95'][1]})" : '';
                $ciP = $m['specificity_ci95'] ? " (95% CI {$m['specificity_ci95'][0]}–{$m['specificity_ci95'][1]})" : '';
                $lines[] = "- **≤ {$cutoff}** — TP {$m['tp']}, FP {$m['fp']}, FN {$m['fn']}, TN {$m['tn']}, excluded {$m['excluded_insufficient']}; sensitivity {$this->fmt($m['sensitivity'])}{$ciS}; specificity {$this->fmt($m['specificity'])}{$ciP}; precision {$this->fmt($m['precision'])}; F1 {$this->fmt($m['f1'])}.";
            }
            $lines[] = '';
        }

        $ch = $summary['detection_channels'];
        $lines[] = '## Detection channel for ground-truth positives (primary cutoff ≤ ' . self::PRIMARY_CUTOFF . ')';
        $lines[] = "- **Source not found** — {$ch['source_not_found']}";
        $lines[] = "- **Verdict channel** — {$ch['verdict']}";
        $lines[] = "- **Missed** — {$ch['missed']}";
        $lines[] = "- **Insufficient (excluded)** — {$ch['excluded_insufficient']}";
        $lines[] = '';

        $up = $summary['upgrades'];
        $lines[] = '## Rejection-review upgrades (rejected → unlikely)';
        $lines[] = "Total upgrades: {$up['total']}.";
        foreach ($up['by_label'] as $label => $count) {
            $lines[] = "- **{$label}** — {$count}";
        }
        $lines[] = '';

        foreach ($summary['breakdowns'] as $dimension => $groups) {
            if ($groups === []) {
                continue;
            }
            $lines[] = "## Breakdown by {$dimension} (at cutoff ≤ " . self::PRIMARY_CUTOFF . ')';
            foreach ($groups as $value => $g) {
                $lines[] = "- **{$value}** — n {$g['n']} ({$g['positives']} pos / {$g['negatives']} neg); sensitivity {$this->fmt($g['sensitivity'])}; FPR {$this->fmt($g['false_positive_rate'])}.";
            }
            $lines[] = '';
        }

        if ($summary['descriptive_labels'] !== []) {
            $lines[] = '## Descriptive labels (retracted arm — outside the binary)';
            foreach ($summary['descriptive_labels'] as $label => $verdicts) {
                $parts = [];
                foreach ($verdicts as $verdict => $count) {
                    $parts[] = "{$verdict}: {$count}";
                }
                $lines[] = "- **{$label}** — " . implode(', ', $parts);
            }
            $lines[] = '';
        }

        $tc = $summary['timing_cost'];
        $lines[] = '## Timing and cost';
        $lines[] = "- **Books** — {$tc['books']} (missing billing rows: {$tc['books_missing_billing']}).";
        $lines[] = "- **Review step seconds** — median {$this->fmt($tc['review_seconds']['median'])}, mean {$this->fmt($tc['review_seconds']['mean'])}, range {$this->fmt($tc['review_seconds']['min'])}–{$this->fmt($tc['review_seconds']['max'])}.";
        $lines[] = "- **Full pipeline seconds** — median {$this->fmt($tc['pipeline_seconds']['median'])}, mean {$this->fmt($tc['pipeline_seconds']['mean'])}.";
        $lines[] = "- **Cost USD per book** — median {$this->fmt($tc['cost_usd']['median'])}, total {$this->fmt($tc['cost_usd']['total'] ?? null)}.";
        $lines[] = "- **Cost USD per citation** — median {$this->fmt($tc['cost_per_citation_usd']['median'])}.";
        $lines[] = '';

        $diag = $summary['join_diagnostics'];
        $lines[] = '## Join diagnostics';
        $lines[] = '- **Orphaned ground truth (emitted as misses)** — ' . (empty($diag['orphan_gt']) ? 'none' : implode(', ', $diag['orphan_gt'])) . '.';
        $lines[] = '- **Claims with defaulted labels** — ' . (empty($diag['defaulted_claims']) ? 'none' : count($diag['defaulted_claims']) . ' (see summary.json)') . '.';
        $lines[] = '- **Skipped books** — ' . (empty($diag['skipped_books']) ? 'none' : implode(', ', $diag['skipped_books'])) . '.';
        $lines[] = '';

        return implode("\n", $lines);
    }

    private function fmt(int|float|null $value): string
    {
        return $value === null ? 'n/a' : (string) $value;
    }
}
