<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Delete archived history for the generated ranking books.
 *
 * `most-recent`, `most-connected`, `most-lit` and `stats` are rebuilt every
 * fifteen minutes by UpdateHomepageJob. Until the versioning trigger learned to
 * skip them, every rebuild archived the previous rows — on production they
 * became the three largest books in nodes_history. Nothing reads that history:
 * these books have no editors and no Time Machine.
 *
 * Dry run by default. Only ever touches nodes_history, only for the fixed list
 * below, and never the live `nodes` rows.
 */
class PurgeSystemNodeHistory extends Command
{
    protected $signature = 'nodes:purge-system-history
        {--force : Actually delete (default is a dry run)}
        {--dry-run : Explicit no-op — the default; wins over --force if both are given}';

    protected $description = 'Delete nodes_history rows for the generated ranking books (dry run by default)';

    /** The fixed ranking books — same list the trigger excludes and SearchService filters out. */
    private const SYSTEM_BOOKS = ['stats', 'most-recent', 'most-connected', 'most-lit'];

    /**
     * Generated book types, identified from library.raw_json rather than a name
     * list — their ids are per-user (`sam`, `samPrivate`, `samAll`, `samAccount`,
     * `sam_public_title`, `shelf_…`) so no pattern or trigger WHEN clause can
     * catch them.
     *
     * Every one is rebuilt by deleting all its nodes and re-inserting
     * (UserHomeServerController::generateUserHomeBook and friends), so each
     * regeneration archives one history row per card. On production the two
     * biggest were a single user's home books at 224k and 109k rows. Nothing
     * reads that history: these books have no editors and no Time Machine.
     */
    private const GENERATED_TYPES = ['user_home', 'user_home_sorted', 'user_account', 'shelf'];

    /** @return array<int, string> */
    private function generatedBooks(): array
    {
        $db = DB::connection('pgsql_admin');

        $generated = $db->table('library')
            ->whereIn(DB::raw("raw_json->>'type'"), self::GENERATED_TYPES)
            ->pluck('book')
            ->all();

        return array_values(array_unique(array_merge(self::SYSTEM_BOOKS, $generated)));
    }

    public function handle(): int
    {
        $force = (bool) $this->option('force') && ! $this->option('dry-run');
        $db = DB::connection('pgsql_admin');

        $books = $this->generatedBooks();
        $this->line(count($books) . ' generated books (ranking + user home/account/shelf).');
        $this->newLine();

        $rows = $db->table('nodes_history')
            ->whereIn('book', $books)
            ->selectRaw('book, count(*) AS n')
            ->groupBy('book')
            ->orderByDesc('n')
            ->get();

        if ($rows->isEmpty()) {
            $this->info('✓ No history rows for the generated ranking books.');

            return self::SUCCESS;
        }

        $total = 0;
        foreach ($rows as $r) {
            $this->line(sprintf('  %-18s %s rows', $r->book, number_format($r->n)));
            $total += $r->n;
        }
        $this->newLine();

        if (! $force) {
            $this->info('Would delete ' . number_format($total) . ' history rows. Re-run with --force.');
            $this->line('The live nodes are untouched either way — this is history only.');

            return self::SUCCESS;
        }

        // Chunked so a huge delete doesn't hold one enormous transaction.
        $deleted = 0;
        do {
            $batch = $db->table('nodes_history')
                ->whereIn('book', $books)
                ->limit(50000)
                ->delete();
            $deleted += $batch;
            if ($batch > 0) {
                $this->line('  deleted ' . number_format($deleted) . '…');
            }
        } while ($batch > 0);

        $this->info('✓ Deleted ' . number_format($deleted) . ' history rows.');
        $this->line('Space is returned to the table\'s free space map; run VACUUM (or VACUUM FULL in a');
        $this->line('maintenance window) to give it back to the filesystem.');

        return self::SUCCESS;
    }
}
