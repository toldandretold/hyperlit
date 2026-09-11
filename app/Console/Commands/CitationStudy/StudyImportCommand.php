<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CorpusManifest;
use App\Services\CitationStudy\GroundTruthBinder;
use App\Services\CitationStudy\StudyBookImporter;
use Illuminate\Console\Command;

class StudyImportCommand extends Command
{
    protected $signature = 'citation:study:import
        {corpus : Corpus name}
        {--book= : Only this slug}
        {--reimport : Purge and re-import books that already exist}';

    protected $description = 'Import corpus books into the local library (study_{corpus}_{slug}) and bind ground truth to the produced referenceIds';

    public function handle(StudyBookImporter $importer, GroundTruthBinder $binder): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));

        $books = $this->option('book')
            ? [$manifest->book($this->option('book'))]
            : $manifest->books();

        $failures = 0;
        foreach ($books as $book) {
            $slug = $book['slug'];
            try {
                $result = $importer->import($manifest, $book, (bool) $this->option('reimport'));
                if ($result['skipped'] ?? false) {
                    $this->line("{$slug}: already imported ({$result['book_id']}) — binding only (--reimport to redo)");
                } else {
                    $this->info("{$slug}: imported {$result['book_id']} ({$result['nodes']} nodes, {$result['bibliography_rows']} bibliography rows)");
                }

                // HTML-sourced books (numbered/Vancouver) can only have their
                // skeleton built AFTER import — it derives from the imported
                // rows, not from parsing the source.
                if (!is_file($manifest->groundTruthPath($book)) && $book['arm'] !== 'synthetic') {
                    $skeleton = app(\App\Services\CitationStudy\CitationCorruptor::class)->skeleton($manifest, $book);
                    $this->info("{$slug}: generated skeleton ground truth with {$skeleton['entries']} entries — verify labels by hand");
                }

                $bound = $binder->bind($manifest, $book);
                $this->info("{$slug}: bound {$bound['bound']} ground-truth entries to {$bound['bib_rows']} bibliography rows");
                if (!empty($bound['unlabelled_reference_ids'])) {
                    $this->warn("{$slug}: bibliography rows with NO ground-truth label (would dilute the intact class): "
                        . implode(', ', $bound['unlabelled_reference_ids']));
                }
            } catch (\Throwable $e) {
                $this->error("{$slug}: {$e->getMessage()}");
                $failures++;
            }
        }

        return $failures === 0 ? 0 : 1;
    }
}
