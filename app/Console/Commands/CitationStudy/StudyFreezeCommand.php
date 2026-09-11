<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CorpusLock;
use App\Services\CitationStudy\CorpusManifest;
use Illuminate\Console\Command;

class StudyFreezeCommand extends Command
{
    protected $signature = 'citation:study:freeze {corpus : Corpus name}';

    protected $description = 'Write corpus.lock.json (sha256 of every corpus file + corruptor code) so reported runs are provably reproducible';

    public function handle(CorpusLock $lock): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));
        $result = $lock->freeze($manifest);
        $this->info("Froze corpus '{$manifest->corpus}': " . count($result['files']) . ' files hashed.');
        if (!$manifest->isFrozen()) {
            $this->warn('Manifest is not marked "frozen": true — the runner only auto-verifies frozen corpora. Add it before test runs.');
        }
        return 0;
    }
}
