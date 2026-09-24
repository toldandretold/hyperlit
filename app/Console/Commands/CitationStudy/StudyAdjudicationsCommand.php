<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\AdjudicationStore;
use App\Services\CitationStudy\CorpusManifest;
use Illuminate\Console\Command;
use RuntimeException;

/**
 * Headless mirror of the /maintainer/study workbench's Apply step: list the
 * human adjudications recorded for a corpus, and fold their labels into
 * ground_truth.json (same code path as the web button).
 */
class StudyAdjudicationsCommand extends Command
{
    protected $signature = 'citation:study:adjudications
        {corpus : Corpus name (study/corpora/{corpus})}
        {--book= : Only this slug}
        {--apply : Fold adjudicated labels into ground_truth.json (refused on a frozen corpus)}';

    protected $description = 'List (and optionally apply) the human adjudications recorded by the /maintainer/study workbench';

    public function handle(AdjudicationStore $store): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));
        $books = $this->option('book')
            ? [$manifest->book($this->option('book'))]
            : $manifest->books();

        $anyApplied = false;
        foreach ($books as $book) {
            $slug = $book['slug'];
            $data = $store->load($manifest, $book);
            $n = count($data['adjudications']);
            if ($n === 0) {
                $this->line("{$slug}: no adjudications");
                continue;
            }

            $byLabel = [];
            $byCause = [];
            $unevidenced = [];
            $scored = AdjudicationStore::evidenceExpectedLabels();
            foreach ($data['adjudications'] as $key => $record) {
                $byLabel[$record['label']] = ($byLabel[$record['label']] ?? 0) + 1;
                $cause = $record['cause'] ?? '(none)';
                $byCause[$cause] = ($byCause[$cause] ?? 0) + 1;
                if (in_array($record['label'], $scored, true)
                    && trim((string) ($record['evidence'] ?? '')) === ''
                ) {
                    $unevidenced[] = $key;
                }
            }
            ksort($byLabel);
            ksort($byCause);
            $labelStr = implode(', ', array_map(fn ($k, $v) => "{$k}×{$v}", array_keys($byLabel), $byLabel));
            $causeStr = implode(', ', array_map(fn ($k, $v) => "{$k}×{$v}", array_keys($byCause), $byCause));
            $this->info("{$slug}: {$n} adjudication(s)");
            $this->line("  labels: {$labelStr}");
            $this->line("  causes: {$causeStr}");
            if ($unevidenced !== []) {
                $this->warn('  un-evidenced (scored labels with no quotation): '
                    . count($unevidenced) . ' — ' . implode(', ', array_slice($unevidenced, 0, 10))
                    . (count($unevidenced) > 10 ? ', …' : ''));
            }

            if ($this->option('apply')) {
                try {
                    $state = app(\App\Services\CitationStudy\StudyRunner::class)->loadState($manifest);
                    $currentRunId = $state['books'][$slug]['run_id'] ?? null;
                    $result = $store->applyToGroundTruth($manifest, $book, $currentRunId);
                } catch (RuntimeException $e) {
                    $this->error("  apply refused: {$e->getMessage()}");
                    return 1;
                }
                $this->info("  applied {$result['applied']} label(s) to ground truth"
                    . ($result['skipped'] !== [] ? ' (skipped unbound: ' . implode(', ', $result['skipped']) . ')' : ''));
                if (($result['stale_mislinks'] ?? []) !== []) {
                    $this->warn('  NOT applied — citation_mislink verdicts from an OLDER run (the phantom '
                        . 'anchors they describe were likely fixed by reimport; re-check in the workbench): '
                        . implode(', ', $result['stale_mislinks']));
                }
                $anyApplied = $anyApplied || $result['applied'] > 0;
            }
        }

        if ($anyApplied) {
            $this->line("Re-run: php artisan citation:study:report {$manifest->corpus}");
        }
        return 0;
    }
}
