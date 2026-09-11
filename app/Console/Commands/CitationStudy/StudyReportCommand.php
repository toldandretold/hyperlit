<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\ClaimsJoiner;
use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\MetricsCalculator;
use App\Services\CitationStudy\StudyRunner;
use Illuminate\Console\Command;

class StudyReportCommand extends Command
{
    protected $signature = 'citation:study:report
        {corpus : Corpus name}
        {--run= : Only rows from this run_id}
        {--allow-orphans : Do not fail on orphaned ground truth / defaulted claims}';

    protected $description = 'Join claims, ground truth, timings and billing into dataset.csv + summary.json + summary.md';

    public function handle(ClaimsJoiner $joiner, MetricsCalculator $metrics, StudyRunner $runner): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));
        $state = $runner->loadState($manifest);
        if (($state['books'] ?? []) === []) {
            $this->error('No run state for this corpus — run citation:study:run first.');
            return 1;
        }

        $runId = $this->option('run') ?: null;
        $joined = $joiner->join($manifest, $state, $runId);
        if ($joined['rows'] === []) {
            $this->error('Join produced zero rows (no completed books' . ($runId ? " for run {$runId}" : '') . ').');
            return 1;
        }

        // Per-book review substage timings from telemetry into the summary.
        $substages = [];
        foreach ($state['books'] as $slug => $bookState) {
            if (!empty($bookState['pipeline_id'])) {
                $seconds = $joiner->reviewSubstageSeconds($bookState['pipeline_id']);
                if ($seconds !== []) {
                    $substages[$slug] = $seconds;
                }
            }
        }

        $summary = $metrics->summarise($joined['rows'], $joined['diagnostics']);
        $summary['review_substage_seconds_by_book'] = $substages;

        // Per-run reports keep cold and warm runs side by side for comparison.
        $outDir = $manifest->resultsDir() . '/report' . ($runId ? "/{$runId}" : '');
        @mkdir($outDir, 0775, true);

        $csvPath = "{$outDir}/dataset.csv";
        $this->writeCsv($csvPath, $joined['rows']);

        file_put_contents(
            "{$outDir}/summary.json",
            json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
        );
        file_put_contents(
            "{$outDir}/summary.md",
            $metrics->toMarkdown($summary, $manifest->corpus, $runId)
        );

        $this->info("Dataset: {$csvPath} (" . count($joined['rows']) . ' rows)');
        $this->info("Summary: {$outDir}/summary.json + summary.md");

        $orphans = $joined['diagnostics']['orphan_gt'];
        $defaulted = $joined['diagnostics']['defaulted_claims'];
        if ($orphans !== []) {
            $this->warn('Orphaned ground truth (emitted as misses): ' . implode(', ', $orphans));
        }
        if ($defaulted !== []) {
            $this->warn(count($defaulted) . ' claims fell back to the book default label.');
        }
        if (($orphans !== [] || $defaulted !== []) && !$this->option('allow-orphans')) {
            $this->error('Join is not clean — inspect before trusting the numbers (--allow-orphans to accept).');
            return 1;
        }

        return 0;
    }

    private function writeCsv(string $path, array $rows): void
    {
        $columns = array_keys($rows[0]);
        $handle = fopen($path, 'w');
        fputcsv($handle, $columns);
        foreach ($rows as $row) {
            fputcsv($handle, array_map(function ($column) use ($row) {
                $value = $row[$column] ?? null;
                if (is_bool($value)) {
                    return $value ? '1' : '0';
                }
                if (is_array($value)) {
                    return json_encode($value);
                }
                return $value;
            }, $columns));
        }
        fclose($handle);
    }
}
