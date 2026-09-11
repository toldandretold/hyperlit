<?php

namespace App\Console\Commands\CitationStudy;

use App\Services\CitationStudy\CitationCorruptor;
use App\Services\CitationStudy\CorpusManifest;
use Illuminate\Console\Command;

class StudyCorruptCommand extends Command
{
    protected $signature = 'citation:study:corrupt
        {corpus : Corpus name (study/corpora/{corpus})}
        {--book= : Only this slug}
        {--check : Regenerate in-memory and fail if outputs differ from disk (determinism guard)}
        {--force-skeleton : Overwrite an existing ground_truth.json for control/retracted books}';

    protected $description = 'Generate corrupted variants + ground truth for a study corpus (synthetic arm), and skeleton ground truth for control/retracted books';

    public function handle(CitationCorruptor $corruptor): int
    {
        $manifest = CorpusManifest::load($this->argument('corpus'));
        if ($manifest->isFrozen() && !$this->option('check')) {
            $this->error("Corpus '{$manifest->corpus}' is frozen — corruption outputs must not change. Use --check to verify.");
            return 1;
        }

        $books = $this->option('book')
            ? [$manifest->book($this->option('book'))]
            : $manifest->books();

        foreach ($books as $book) {
            $slug = $book['slug'];
            if ($book['arm'] === 'synthetic') {
                if ($this->option('check')) {
                    if (!$this->checkDeterminism($corruptor, $manifest, $book)) {
                        return 1;
                    }
                    continue;
                }
                $result = $corruptor->corrupt($manifest, $book);
                $this->info(sprintf(
                    '%s: %d entries (%d cited, %d occurrences) — %d fabricated, %d swapped, %d distorted',
                    $slug, $result['entries'], $result['cited_entries'], $result['occurrences'],
                    $result['fabricated'], $result['swapped'], $result['distorted']
                ));
                continue;
            }

            // Control / retracted arms: skeleton only, never clobber hand labels.
            $gtPath = $manifest->groundTruthPath($book);
            if (is_file($gtPath) && !$this->option('force-skeleton')) {
                $this->line("{$slug}: ground truth exists — leaving hand labels alone (--force-skeleton to regenerate)");
                continue;
            }
            if ($this->option('check')) {
                continue;
            }
            $result = $corruptor->skeleton($manifest, $book);
            $this->info("{$slug}: skeleton ground truth with {$result['entries']} entries ({$result['occurrences']} occurrences) — verify labels by hand");
            foreach ($result['warnings'] ?? [] as $warning) {
                $this->warn("  {$warning}");
            }
        }

        return 0;
    }

    private function checkDeterminism(CitationCorruptor $corruptor, CorpusManifest $manifest, array $book): bool
    {
        $slug = $book['slug'];
        $result = $corruptor->corrupt($manifest, $book, dryRun: true);

        $corruptedPath = $manifest->path($book['study_file'] ?? "sources/{$slug}/corrupted.md");
        $gtPath = $manifest->groundTruthPath($book);
        if (!is_file($corruptedPath) || !is_file($gtPath)) {
            $this->error("{$slug}: outputs missing on disk — run without --check first.");
            return false;
        }

        if ($result['corrupted_md'] !== (string) file_get_contents($corruptedPath)) {
            $this->error("{$slug}: corrupted.md on disk differs from deterministic regeneration.");
            return false;
        }

        // Compare ground truth ignoring binding state (bind mutates the file).
        $onDisk = json_decode((string) file_get_contents($gtPath), true) ?: [];
        $fresh = $result['ground_truth'];
        $strip = function (array $gt): array {
            unset($gt['binding']);
            foreach ($gt['entries'] as &$entry) {
                unset($entry['bound_reference_id']);
            }
            return $gt;
        };
        if ($strip($onDisk) !== $strip($fresh)) {
            $this->error("{$slug}: ground_truth.json on disk differs from deterministic regeneration.");
            return false;
        }

        $this->info("{$slug}: deterministic ✓");
        return true;
    }
}
