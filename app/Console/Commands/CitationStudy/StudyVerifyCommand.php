<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CorpusLock;
use App\Services\CitationStudy\CorpusManifest;
use Illuminate\Console\Command;

class StudyVerifyCommand extends Command
{
    protected $signature = 'citation:study:verify {corpus : Corpus name}';

    protected $description = 'Verify a corpus against its corpus.lock.json';

    public function handle(CorpusLock $lock): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));
        $problems = $lock->verify($manifest);
        if ($problems === []) {
            $this->info("Corpus '{$manifest->corpus}' matches its lock.");
            return 0;
        }
        foreach ($problems as $problem) {
            $this->error($problem);
        }
        return 1;
    }
}
