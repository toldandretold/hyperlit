<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\StudyRunner;
use Illuminate\Console\Command;

class StudyRunCommand extends Command
{
    protected $signature = 'citation:study:run
        {corpus : Corpus name}
        {--book= : Only this slug}
        {--force-rerun : Re-run books already marked completed in state.json}
        {--dry-run : Show what would run without running anything}';

    protected $description = 'Run the full citation pipeline over a study corpus with per-run provenance, exact claims capture, resumable state, and a contamination audit';

    public function handle(StudyRunner $runner): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));

        $result = $runner->run(
            $manifest,
            $this->option('book') ?: null,
            (bool) $this->option('force-rerun'),
            (bool) $this->option('dry-run'),
            fn (string $line) => $this->line("  {$line}"),
        );

        if ($result['dry_run'] ?? false) {
            $this->info('Dry run. Would run: ' . (empty($result['planned']) ? '(nothing)' : implode(', ', $result['planned'])));
            return 0;
        }
        if (($result['planned'] ?? []) === []) {
            $this->info($result['message'] ?? 'Nothing to run.');
            return 0;
        }

        $this->newLine();
        $this->info("Run {$result['run_id']} finished. Artifacts: {$result['run_dir']}");

        $failures = 0;
        foreach ($result['state']['books'] as $slug => $book) {
            if (!in_array($slug, $result['planned'], true)) {
                continue;
            }
            $status = $book['status'] ?? 'unknown';
            $line = "  {$slug}: {$status}";
            if (!empty($book['contamination'])) {
                $line .= ' ⚠ CONTAMINATED';
            }
            if ($status === 'failed') {
                $failures++;
                $line .= ' — ' . ($book['error'] ?? 'see log');
            }
            $status === 'completed' ? $this->info($line) : $this->error($line);
        }

        return $failures === 0 ? 0 : 1;
    }
}
