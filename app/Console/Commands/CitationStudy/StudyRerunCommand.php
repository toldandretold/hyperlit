<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\StudyCitationRerunner;
use Illuminate\Console\Command;

/** @see StudyReportCommand which warns when a joined record is a patched run */
class StudyRerunCommand extends Command
{
    protected $signature = 'citation:study:rerun
        {corpus : Corpus name}
        {slug : Book slug within the corpus}
        {citation : gt_id (e.g. c04) or referenceId}
        {--dry-run : Resolve the citation and show what would run without running anything}';

    protected $description = 'Re-run ONE citation (extraction → ladder → review) and patch it into a new '
        . 'sub-versioned run ({base}.N) the workbench picks up. Refuses frozen corpora and books re-imported '
        . 'since the base run (a reconvert reissues every referenceId — the unit after a reconvert is the '
        . 'whole book, via citation:study:run --book --force-rerun). No --reimport on purpose, same reason.';

    public function handle(StudyCitationRerunner $rerunner): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));

        try {
            $result = $rerunner->rerun(
                $manifest,
                $this->argument('slug'),
                $this->argument('citation'),
                (bool) $this->option('dry-run'),
                fn (string $line) => $this->line("  {$line}"),
            );
        } catch (\RuntimeException $e) {
            $this->error($e->getMessage());
            return 1;
        }

        $gtIds = $result['gt_ids'] ? implode(', ', $result['gt_ids']) : '(none bound)';

        if ($result['dry_run'] ?? false) {
            $this->info("Dry run. Would re-run {$result['reference_id']} (gt: {$gtIds}) "
                . "against base {$result['base_run']} as {$result['run_id']}.");
            return 0;
        }

        $this->newLine();
        $this->info("Patched run {$result['run_id']} (base {$result['base_run']}).");
        $this->line("  Citation:   {$result['reference_id']} (gt: {$gtIds})");
        $this->line("  Rows:       {$result['replaced']} replaced, {$result['inserted']} fresh");
        $this->line("  Claims:     {$result['claims_file']}");
        if (!empty($result['contamination'])) {
            foreach ($result['contamination'] as $flag) {
                $this->warn("  CONTAMINATION: {$flag}");
            }
        }
        $this->info('Workbench will show the patched run on next load.');

        return 0;
    }
}
