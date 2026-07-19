<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Import a book:export case bundle into THIS environment (the dev half of
 * the bad-conversion loop). Lands the DB rows via pgsql_admin (RLS bypass)
 * and unpacks the artifact dir to resources/markdown/{book}/ — after which
 * the book opens in the local reader, `php artisan …reconvert…` replays the
 * cached OCR, and tests/conversion/add_fixture.py can capture it as a
 * regression fixture. `creator_token` is scrubbed on the way in.
 */
class BookImport extends Command
{
    protected $signature = 'book:import
        {archive : Path to the .tar.gz produced by book:export}
        {--force : Replace the book if it already exists locally}
        {--keep-tokens : Do not scrub creator_token (default scrubs)}';

    protected $description = 'Import a book:export case bundle (DB rows + artifacts)';

    public function handle(): int
    {
        $archive = (string) $this->argument('archive');
        if (!is_file($archive)) {
            $this->error("No archive at {$archive}.");
            return self::FAILURE;
        }

        $stage = storage_path('app/book-exports/.import-stage-' . getmypid());
        File::deleteDirectory($stage);
        File::ensureDirectoryExists($stage);
        exec(sprintf('tar -xzf %s -C %s', escapeshellarg($archive), escapeshellarg($stage)), $o, $code);
        if ($code !== 0) {
            $this->error("tar extraction failed (exit {$code}).");
            return self::FAILURE;
        }

        try {
            $manifest = json_decode((string) file_get_contents("{$stage}/manifest.json"), true);
            $book = $manifest['book'] ?? null;
            if (!$book) {
                $this->error('Bundle has no manifest/book.');
                return self::FAILURE;
            }

            $db = DB::connection('pgsql_admin');

            if ($db->table('library')->where('book', $book)->exists()) {
                if (!$this->option('force')) {
                    $this->error("'{$book}' already exists locally — rerun with --force to replace it.");
                    return self::FAILURE;
                }
                $this->purge($db, $book);
            }

            $counts = [];

            $counts['library'] = $this->insertJson($db, 'library', "{$stage}/db/library.json");
            $counts['nodes'] = $this->insertNodesJsonl($db, "{$stage}/db/nodes.jsonl");
            foreach (['footnotes', 'bibliography', 'hyperlights', 'hypercites'] as $table) {
                $counts[$table] = $this->insertJson($db, $table, "{$stage}/db/{$table}.json");
            }
            // Flags go through the DEFAULT connection (table carries no RLS).
            $counts['conversion_flags'] = $this->insertJson(DB::connection(), 'conversion_flags', "{$stage}/db/conversion_flags.json");

            if (is_dir("{$stage}/artifacts")) {
                $dest = resource_path("markdown/{$book}");
                File::deleteDirectory($dest);
                File::copyDirectory("{$stage}/artifacts", $dest);
                $counts['artifact_files'] = count(File::allFiles($dest));
            }

            $this->info("Imported {$book} from {$archive}");
            foreach ($counts as $k => $v) {
                $this->line("  {$k}: {$v}");
            }
            $this->line('Next: open the book in the local reader, or capture a fixture:');
            $this->line("  python3 tests/conversion/add_fixture.py --name <case> --source resources/markdown/{$book}");

            return self::SUCCESS;
        } finally {
            File::deleteDirectory($stage);
        }
    }

    /** Remove every trace of the book locally before a --force re-import. */
    private function purge($db, string $book): void
    {
        foreach (['nodes', 'footnotes', 'bibliography', 'hyperlights', 'hypercites', 'library'] as $table) {
            $db->table($table)->where('book', $book)->orWhere('book', 'like', "{$book}/%")->delete();
        }
        DB::table('conversion_flags')->where('book', $book)->delete();
        File::deleteDirectory(resource_path("markdown/{$book}"));
        $this->line("  (purged existing {$book})");
    }

    private function insertJson($db, string $table, string $path): int
    {
        if (!is_file($path)) {
            return 0;
        }
        $rows = json_decode((string) file_get_contents($path), true) ?: [];
        foreach (array_chunk($rows, 200) as $chunk) {
            $db->table($table)->insert(array_map(fn ($r) => $this->scrub($r), $chunk));
        }

        return count($rows);
    }

    private function insertNodesJsonl($db, string $path): int
    {
        if (!is_file($path)) {
            return 0;
        }
        $count = 0;
        $batch = [];
        $fh = fopen($path, 'r');
        while (($line = fgets($fh)) !== false) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $batch[] = $this->scrub(json_decode($line, true));
            $count++;
            if (count($batch) >= 200) {
                $db->table('nodes')->insert($batch);
                $batch = [];
            }
        }
        if ($batch) {
            $db->table('nodes')->insert($batch);
        }
        fclose($fh);

        return $count;
    }

    private function scrub(array $row): array
    {
        if (!$this->option('keep-tokens') && array_key_exists('creator_token', $row)) {
            $row['creator_token'] = null;
        }

        return $row;
    }
}
