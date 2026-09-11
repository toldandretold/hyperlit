<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\ClaimsJoiner;
use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\MetricsCalculator;
use App\Services\CitationStudy\StudyRunner;
use Illuminate\Console\Command;

/**
 * Cross-run comparison: the commons-dividend timing matrix (per book, per
 * run: pipeline/step seconds + cost) and inter-run verdict reliability
 * (pairwise exact / within-one-step agreement + Cohen's kappa). Citations
 * join across runs by (referenceId, node_id, charStart) — stable because
 * re-runs review the same imported book without re-importing.
 */
class StudyCompareCommand extends Command
{
    protected $signature = 'citation:study:compare {corpus : Corpus name}';

    protected $description = 'Compare repeated runs: per-run timing/cost per book (cold vs warm commons) and cross-run verdict agreement';

    private const LADDER = ['rejected' => 0, 'unlikely' => 1, 'plausible' => 2, 'likely' => 3, 'confirmed' => 4];

    public function handle(StudyRunner $runner, ClaimsJoiner $joiner, MetricsCalculator $metrics): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));
        $state = $runner->loadState($manifest);
        if (($state['books'] ?? []) === []) {
            $this->error('No run state — run citation:study:run first.');
            return 1;
        }

        $outDir = $manifest->resultsDir() . '/report';
        @mkdir($outDir, 0775, true);

        $timingRows = [];
        $verdictRows = [];
        $agreement = [];

        foreach ($manifest->books() as $book) {
            $slug = $book['slug'];
            $latest = $state['books'][$slug] ?? null;
            if (!$latest) {
                continue;
            }
            $records = array_merge($latest['history'] ?? [], [$latest]);
            $records = array_values(array_filter(
                $records,
                fn ($r) => ($r['status'] ?? null) === 'completed' && !empty($r['claims_file']) && is_file($r['claims_file'])
            ));
            usort($records, fn ($a, $b) => strcmp($a['run_id'] ?? '', $b['run_id'] ?? ''));
            if ($records === []) {
                continue;
            }

            // --- timing/cost per run --------------------------------------
            foreach ($records as $i => $record) {
                $timings = $joiner->stepTimings($record['pipeline_id'] ?? null);
                $billing = $joiner->billing($record['pipeline_id'] ?? null);
                $timingRows[] = [
                    'slug' => $slug,
                    'run_id' => $record['run_id'],
                    'run_index' => $i + 1,
                    'bibliography_seconds' => $timings['steps']['bibliography']['duration_seconds'] ?? null,
                    'content_seconds' => $timings['steps']['content']['duration_seconds'] ?? null,
                    'vacuum_seconds' => $timings['steps']['vacuum']['duration_seconds'] ?? null,
                    'ocr_seconds' => $timings['steps']['ocr']['duration_seconds'] ?? null,
                    'review_seconds' => $timings['steps']['review']['duration_seconds'] ?? null,
                    'wall_seconds' => $timings['wall_seconds'],
                    'ocr_pages' => $timings['steps']['ocr']['total_pages'] ?? null,
                    'cost_usd' => $billing['total'],
                ];
            }

            // --- verdicts per citation per run ----------------------------
            $byRun = [];
            foreach ($records as $record) {
                $claims = json_decode((string) file_get_contents($record['claims_file']), true) ?: [];
                foreach ($claims as $claim) {
                    $key = implode('|', [
                        $claim['referenceId'] ?? '',
                        $claim['node_id'] ?? '',
                        $claim['charStart'] ?? '',
                    ]);
                    $verdict = !empty($claim['source_book_id'])
                        ? ($claim['llm_verdict']['support'] ?? 'insufficient')
                        : 'source_not_found';
                    $byRun[$record['run_id']][$key] = $verdict;
                    $verdictRows[] = [
                        'slug' => $slug,
                        'run_id' => $record['run_id'],
                        'referenceId' => $claim['referenceId'] ?? null,
                        'node_id' => $claim['node_id'] ?? null,
                        'charStart' => $claim['charStart'] ?? null,
                        'verdict' => $verdict,
                        'evidence_type' => $claim['evidence_type'] ?? null,
                    ];
                }
            }

            // --- pairwise agreement ---------------------------------------
            $runIds = array_keys($byRun);
            for ($a = 0; $a < count($runIds); $a++) {
                for ($b = $a + 1; $b < count($runIds); $b++) {
                    $keys = array_intersect(array_keys($byRun[$runIds[$a]]), array_keys($byRun[$runIds[$b]]));
                    if ($keys === []) {
                        continue;
                    }
                    $va = [];
                    $vb = [];
                    $exact = 0;
                    $withinOne = 0;
                    foreach ($keys as $key) {
                        $va[] = $byRun[$runIds[$a]][$key];
                        $vb[] = $byRun[$runIds[$b]][$key];
                        if (end($va) === end($vb)) {
                            $exact++;
                            $withinOne++;
                        } elseif (isset(self::LADDER[end($va)], self::LADDER[end($vb)])
                            && abs(self::LADDER[end($va)] - self::LADDER[end($vb)]) <= 1
                        ) {
                            $withinOne++;
                        }
                    }
                    $n = count($keys);
                    $agreement[] = [
                        'slug' => $slug,
                        'run_a' => $runIds[$a],
                        'run_b' => $runIds[$b],
                        'n_common_citations' => $n,
                        'exact_agreement' => round($exact / $n, 4),
                        'within_one_step' => round($withinOne / $n, 4),
                        'cohen_kappa' => $metrics->cohenKappa($va, $vb),
                        'only_in_a' => count($byRun[$runIds[$a]]) - $n,
                        'only_in_b' => count($byRun[$runIds[$b]]) - $n,
                    ];
                }
            }
        }

        if ($timingRows === []) {
            $this->error('No completed runs to compare.');
            return 1;
        }

        $this->writeCsv("{$outDir}/timing_by_run.csv", $timingRows);
        $this->writeCsv("{$outDir}/verdicts_by_run.csv", $verdictRows);
        file_put_contents(
            "{$outDir}/comparison.json",
            json_encode(['timing' => $timingRows, 'agreement' => $agreement], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
        );
        file_put_contents("{$outDir}/comparison.md", $this->markdown($manifest->corpus, $timingRows, $agreement));

        $this->info("Timing matrix: {$outDir}/timing_by_run.csv (" . count($timingRows) . ' book-runs)');
        $this->info("Verdicts long-format: {$outDir}/verdicts_by_run.csv (" . count($verdictRows) . ' rows)');
        $this->info("Agreement + summary: {$outDir}/comparison.json / comparison.md");
        return 0;
    }

    private function markdown(string $corpus, array $timingRows, array $agreement): string
    {
        $lines = ["# Cross-run comparison — corpus `{$corpus}`", ''];

        $lines[] = '## Timing per book per run (the commons dividend)';
        $bySlug = [];
        foreach ($timingRows as $row) {
            $bySlug[$row['slug']][] = $row;
        }
        foreach ($bySlug as $slug => $rows) {
            $lines[] = "### {$slug}";
            foreach ($rows as $row) {
                $lines[] = sprintf(
                    '- **run %d** (`%s`) — wall %ss; bibliography %ss, content %ss, vacuum %ss, ocr %ss (%s pages), review %ss; cost $%s.',
                    $row['run_index'], $row['run_id'],
                    $row['wall_seconds'] ?? 'n/a', $row['bibliography_seconds'] ?? 'n/a',
                    $row['content_seconds'] ?? 'n/a', $row['vacuum_seconds'] ?? 'n/a',
                    $row['ocr_seconds'] ?? 'n/a', $row['ocr_pages'] ?? '0',
                    $row['review_seconds'] ?? 'n/a', $row['cost_usd'] ?? 'n/a'
                );
            }
            $lines[] = '';
        }

        $lines[] = '## Inter-run verdict agreement (reliability)';
        if ($agreement === []) {
            $lines[] = 'Only one completed run so far — agreement needs at least two.';
        }
        foreach ($agreement as $pair) {
            $lines[] = sprintf(
                '- **%s** `%s` vs `%s` — n %d; exact %.1f%%; within one step %.1f%%; kappa %s; unmatched citations a/b: %d/%d.',
                $pair['slug'], $pair['run_a'], $pair['run_b'], $pair['n_common_citations'],
                $pair['exact_agreement'] * 100, $pair['within_one_step'] * 100,
                $pair['cohen_kappa'] ?? 'n/a', $pair['only_in_a'], $pair['only_in_b']
            );
        }
        $lines[] = '';
        return implode("\n", $lines);
    }

    private function writeCsv(string $path, array $rows): void
    {
        $handle = fopen($path, 'w');
        fputcsv($handle, array_keys($rows[0]));
        foreach ($rows as $row) {
            fputcsv($handle, array_values($row));
        }
        fclose($handle);
    }
}
