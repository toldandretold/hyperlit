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
        {archive : Path to the .tar.gz (or gunzipped .tar) produced by book:export}
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
        // -xf (no z): tar auto-detects gzip, so a Safari-gunzipped .tar imports too.
        exec(sprintf('tar -xf %s -C %s', escapeshellarg($archive), escapeshellarg($stage)), $o, $code);
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

            // canonical_source first: for a harvest case it is the acquisition
            // evidence (is_oa / oa_status / oa_locations / pdf_url — what
            // OpenAlex actually claimed). Insert-if-absent, never replaced: one
            // canonical row is shared by every version of the work, so a --force
            // re-import of one book must not clobber (or delete) it.
            $counts['canonical_source'] = $this->insertCanonicalSource($db, "{$stage}/db/canonical_source.json");

            // The journal registry row, when the case came off a journal lane. Insert-if-absent
            // like the canonical: without it `canonical_source.journal_source_id` points at
            // nothing locally and /maintainer/journal-import can't open the case you just pulled.
            // Matched by natural key, not id: each env mints its own uuid for the same journal.
            [$counts['journal_sources'], $journalIdMap] = $this->importJournalSources($db, "{$stage}/db/journal_sources.json");

            // Re-point canonical rows still carrying the bundle's journal uuid at the local
            // registry row — covers this run's inserts and any landed by an earlier partial import.
            foreach ($journalIdMap as $bundleId => $localId) {
                $db->table('canonical_source')->where('journal_source_id', $bundleId)->update(['journal_source_id' => $localId]);
            }

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

            // Exports strip the embedding column and these raw inserts bypass
            // PgNode's hook — queue re-embedding or the imported book stays
            // invisible to embedding retrieval.
            \App\Jobs\QueueBookEmbeddings::dispatch($book);

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

    /**
     * Insert canonical_source rows that aren't here yet. Shared across books and
     * across cases, so existing rows are left exactly as they are.
     */
    private function insertCanonicalSource($db, string $path): int
    {
        if (!is_file($path)) {
            return 0;
        }
        $rows = json_decode((string) file_get_contents($path), true) ?: [];
        $inserted = 0;
        foreach ($rows as $row) {
            if (empty($row['id']) || $db->table('canonical_source')->where('id', $row['id'])->exists()) {
                continue;
            }
            $db->table('canonical_source')->insert($this->scrub($row));
            $inserted++;
        }

        return $inserted;
    }

    /**
     * Land the journal registry rows a case references. The same journal usually
     * already exists locally under a DIFFERENT uuid (each env mints its own), and
     * journal_sources carries unique natural keys (openalex_source_id, slug) — so
     * an id-only insert-if-absent hits the unique constraint. Match by natural key
     * instead, and return [inserted, bundle-id → local-id map] so callers can
     * re-point canonical_source.journal_source_id at the local row.
     */
    private function importJournalSources($db, string $path): array
    {
        if (!is_file($path)) {
            return [0, []];
        }
        $rows = json_decode((string) file_get_contents($path), true) ?: [];
        $inserted = 0;
        $idMap = [];
        foreach ($rows as $row) {
            if (empty($row['id']) || $db->table('journal_sources')->where('id', $row['id'])->exists()) {
                continue;
            }
            $localId = $db->table('journal_sources')
                ->where('openalex_source_id', $row['openalex_source_id'] ?? '')
                ->when(!empty($row['slug']), fn ($q) => $q->orWhere('slug', $row['slug']))
                ->value('id');
            if ($localId) {
                $idMap[$row['id']] = $localId;
                continue;
            }
            $db->table('journal_sources')->insert($this->scrub($row));
            $inserted++;
        }

        return [$inserted, $idMap];
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
