<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CorpusLock;
use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\EvidenceCoverage;
use Illuminate\Console\Command;

class StudyFreezeCommand extends Command
{
    protected $signature = 'citation:study:freeze {corpus : Corpus name}';

    protected $description = 'Write corpus.lock.json (sha256 of every corpus file + corruptor code) so reported runs are provably reproducible';

    public function handle(CorpusLock $lock, EvidenceCoverage $coverage): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));
        $result = $lock->freeze($manifest);
        $this->info("Froze corpus '{$manifest->corpus}': " . count($result['files']) . ' files hashed.');
        if (!$manifest->isFrozen()) {
            $this->warn('Manifest is not marked "frozen": true — the runner only auto-verifies frozen corpora. Add it before test runs.');
        }

        $this->reportEvidenceCoverage($coverage->forCorpus($manifest));

        // Deliberately still 0. Freezing is the operator's call; an un-evidenced
        // label is a weakness in the paper's defence, not a broken corpus — and
        // blocking here would only teach people to skip the command.
        return 0;
    }

    /**
     * The moment to notice missing evidence is the moment a corpus becomes the
     * thing reported runs are measured against — after this, every evidence
     * edit changes a hashed file and invalidates the lock.
     */
    private function reportEvidenceCoverage(array $coverage): void
    {
        $this->line('');
        $this->line(EvidenceCoverage::summaryLine($coverage));

        foreach ($coverage['missing'] as $row) {
            $this->warn("  no evidence: {$row['ref']} ({$row['label']})");
        }
        if ($coverage['missing'] !== []) {
            $this->warn('A scored human label with no quotation is an assertion the paper cannot show. Add evidence in /maintainer/study, then re-freeze.');
        }

        foreach ($coverage['exempt_without_note'] as $row) {
            $this->warn("  exempt from evidence but has no note explaining why: {$row['ref']} ({$row['label']})");
        }
    }
}
