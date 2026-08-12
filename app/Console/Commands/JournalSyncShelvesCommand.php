<?php

namespace App\Console\Commands;

use App\Models\JournalSource;
use App\Services\SourceHarvest\HarvestShelf;
use Illuminate\Console\Command;

/**
 * Reconcile journal shelves with the canonical truth (shelf_items must never
 * drift from the canonical_source.journal_source_id join — the journal page's
 * feeds are shelf-backed). Content-side counterpart to journal:sync-registry's
 * metadata pass; run it after imports that bypass journal:harvest.
 */
class JournalSyncShelvesCommand extends Command
{
    protected $signature = 'journal:sync-shelves
                            {slug? : Registry slug (omit to reconcile every journal)}';

    protected $description = 'Reconcile each journal\'s public shelf with its canonicals: add missing content-bearing version books, heal year/volume/issue on version rows, flush stale shelf renders.';

    public function handle(HarvestShelf $shelf): int
    {
        $slug = trim((string) $this->argument('slug')) ?: null;

        if ($slug) {
            $journal = JournalSource::where('slug', $slug)->first();
            if (!$journal) {
                $this->error("No registry row for slug \"{$slug}\".");
                return 1;
            }
            $journals = collect([$journal]);
        } else {
            $journals = JournalSource::orderBy('display_name')->cursor();
        }

        $total = 0;
        $count = 0;
        foreach ($journals as $journal) {
            $added = $shelf->syncJournalShelfMembership($journal);
            $total += $added;
            $count++;
            if ($added > 0 || $slug) {
                $this->line(sprintf('  %-50s +%d', $journal->slug, $added));
            }
        }

        $this->info("Reconciled {$count} journal(s); {$total} book(s) added to shelves.");

        return 0;
    }
}
