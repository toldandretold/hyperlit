<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Book Snapshots - View Book Version History
 *
 * PURPOSE:
 * Lists distinct points in time when the book changed, showing snapshots
 * that can be used with book:preview and book:restore commands.
 *
 * USAGE:
 * php artisan book:snapshots {book}              # Show recent snapshots
 * php artisan book:snapshots {book} --limit=50   # Show more snapshots
 *
 * EXAMPLE:
 * php artisan book:snapshots my-book-id
 */
class BookSnapshots extends Command
{
    protected $signature = 'book:snapshots {book} {--limit=20 : Number of snapshots to show}';
    protected $description = 'List version history snapshots for a book';

    public function handle()
    {
        $bookId = $this->argument('book');
        $limit = (int) $this->option('limit');

        // Check if book exists
        $bookExists = DB::table('nodes')->where('book', $bookId)->exists();
        $historyExists = DB::table('nodes_history')->where('book', $bookId)->exists();

        if (!$bookExists && !$historyExists) {
            $this->error("Book not found: {$bookId}");
            return 1;
        }

        // Get current node count
        $currentNodeCount = DB::table('nodes')->where('book', $bookId)->count();

        $this->newLine();
        $this->info("Book History: {$bookId}");
        $this->line(str_repeat('═', 70));
        $this->newLine();

        // Get distinct snapshots (points in time when changes occurred)
        // Each unique upper(sys_period) represents when a version was superseded
        $snapshots = DB::select("
            SELECT
                upper(sys_period) as changed_at,
                COUNT(*) as nodes_changed,
                array_agg(DISTINCT type) as types_changed
            FROM nodes_history
            WHERE book = ?
            AND upper(sys_period) IS NOT NULL
            GROUP BY upper(sys_period)
            ORDER BY upper(sys_period) DESC
            LIMIT ?
        ", [$bookId, $limit]);

        if (empty($snapshots)) {
            $this->warn("No history found for this book yet.");
            $this->line("History is created when nodes are updated or deleted.");
            $this->newLine();
            $this->line("Current state: {$currentNodeCount} nodes");
            return 0;
        }

        // Display as table
        $this->line(" #   Timestamp                      Nodes Changed   Types");
        $this->line(str_repeat('─', 70));

        // Add current state as #0
        $this->line(sprintf(
            " <fg=green>0</>   <fg=green>%s</>   <fg=green>%d nodes</>         <fg=green>current state</>",
            now()->format('Y-m-d H:i:s P'),
            $currentNodeCount
        ));

        foreach ($snapshots as $index => $snapshot) {
            $num = $index + 1;
            $timestamp = $snapshot->changed_at;
            $nodesChanged = $snapshot->nodes_changed;

            // Parse the PostgreSQL array of types
            $typesRaw = trim($snapshot->types_changed, '{}');
            $typesRaw = str_replace(['NULL', 'null', '"'], '', $typesRaw);
            $types = $typesRaw ?: 'paragraph';
            $types = trim($types, ',');
            if (strlen($types) > 20) {
                $types = substr($types, 0, 17) . '...';
            }

            $nodeWord = $nodesChanged === 1 ? 'node' : 'nodes';

            $this->line(sprintf(
                " %-3d %s   %d %s   %s",
                $num,
                $timestamp,
                $nodesChanged,
                str_pad($nodeWord, 5),
                $types
            ));
        }

        $this->newLine();
        $this->line("Usage:");
        $this->line("  Preview:  <fg=cyan>php artisan book:preview {$bookId} --at=1</>");
        $this->line("  Restore:  <fg=cyan>php artisan book:restore {$bookId} --at=1 --dry-run</>");
        $this->newLine();
        $this->line("<fg=gray>Note: --at=1 means 'before snapshot #1 occurred' (i.e., restore to that state)</>");

        return 0;
    }
}
