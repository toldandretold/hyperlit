<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Remove content stranded inside deleted ROOT books.
 *
 * When a book is deleted mid-import, the conversion finishes and writes its
 * nodes anyway — into a book that no longer logically exists. The library row
 * survives (marked `deleted`), so the orphan sweep never sees it: that looks
 * for a MISSING row, and this one is present.
 *
 * Sub-books are never touched. BookDeletionService preserves `metadata_only`
 * descendants on purpose, so that highlights pointing into footnote sub-books
 * still resolve after the parent is gone — on production that is 497 sub-books
 * holding 513 nodes, and every one of them is meant to be there.
 *
 * Dry run by default.
 */
class PurgeDeletedBookContent extends Command
{
    protected $signature = 'nodes:purge-deleted-books
        {--force : Actually delete (default is a dry run)}
        {--dry-run : Explicit no-op — the default; wins over --force if both are given}
        {--book= : Limit to one book id}';

    protected $description = 'Delete nodes stranded in deleted root books (dry run by default)';

    public function handle(): int
    {
        $force = (bool) $this->option('force') && ! $this->option('dry-run');
        $db = DB::connection('pgsql_admin');

        $rows = $db->table('nodes as n')
            ->join('library as l', 'l.book', '=', 'n.book')
            ->where('l.visibility', 'deleted')
            ->where('n.book', 'not like', '%/%')          // root books only — never sub-books
            ->when($this->option('book'), fn ($q, $b) => $q->where('n.book', $b))
            ->selectRaw('n.book, COUNT(*) AS nodes, MIN(n.created_at) AS first_written, MAX(l.updated_at) AS deleted_at')
            ->groupBy('n.book')
            ->orderByDesc('nodes')
            ->get();

        if ($rows->isEmpty()) {
            $this->info('✓ No content stranded in deleted root books.');

            return self::SUCCESS;
        }

        $total = 0;
        foreach ($rows as $r) {
            // Written AFTER the delete = the in-flight race. Written before =
            // a delete that didn't finish the job. Both are strandings; the
            // distinction is worth seeing before anyone presses --force.
            $race = $r->first_written > $r->deleted_at ? 'written after delete' : 'predates delete';
            $this->line(sprintf('  %-34s %8s nodes   (%s)', $r->book, number_format($r->nodes), $race));
            $total += $r->nodes;
        }
        $this->newLine();

        if (! $force) {
            $this->info('Would delete ' . number_format($total) . ' nodes from ' . $rows->count() . ' deleted book(s).');
            $this->line('Sub-books are excluded — their content is preserved deliberately.');
            $this->line('Re-run with --force. There is no undo.');

            return self::SUCCESS;
        }

        $deleted = 0;
        foreach ($rows as $r) {
            // Re-check at delete time rather than trusting the list above.
            $stillDeleted = $db->table('library')->where('book', $r->book)->where('visibility', 'deleted')->exists();
            if (! $stillDeleted) {
                $this->warn("  SKIP {$r->book} — no longer marked deleted");

                continue;
            }
            $deleted += $db->table('nodes')->where('book', $r->book)->delete();
        }

        $this->info('✓ Deleted ' . number_format($deleted) . ' nodes.');

        return self::SUCCESS;
    }
}
