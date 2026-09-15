<?php

namespace App\Console\Commands;

use App\Services\Citations\AmbiguousCitationRegistry;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Backfill / repair for the ambiguous-citation ledger.
 *
 * The registry normally syncs inside every import job, so this exists for the gaps that hook
 * cannot reach: books reconverted BEFORE the hook shipped (their nodes carry the marker but no
 * rows exist), a sync that failed best-effort mid-import, or a sanity re-run before opening
 * /maintainer/citations on a fresh corpus. Idempotent — sync() updates in place.
 */
class CitationSyncAmbiguousCommand extends Command
{
    protected $signature = 'citations:sync-ambiguous
        {--book= : Sync one book}
        {--journal= : Journal slug, display-name fragment or journal_sources id}
        {--limit=0 : Stop after N books (0 = all)}';

    protected $description = 'Register ambiguous citation links as pending questions (and re-apply resolved ones)';

    public function handle(AmbiguousCitationRegistry $registry): int
    {
        $db = DB::connection('pgsql_admin');

        // Only books whose nodes actually carry the marker — a LIKE over nodes is the cheapest
        // corpus-wide filter, and it keeps this a seconds-long command instead of a full scan.
        $query = $db->table('nodes')
            ->where('content', 'like', '%data-resolved="ambiguous"%')
            ->distinct();

        if ($book = $this->option('book')) {
            $query->where('book', $book);
        }
        if ($journal = $this->option('journal')) {
            $isUuid = (bool) preg_match(
                '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $journal);
            $sourceId = $db->table('journal_sources')
                ->when($isUuid, fn ($q) => $q->where('id', $journal))
                ->when(!$isUuid, fn ($q) => $q->where('slug', $journal)
                    ->orWhere('display_name', 'ilike', '%' . $journal . '%'))
                ->value('id');
            if (!$sourceId) {
                $this->error("No journal_sources row matches '{$journal}'.");
                return self::FAILURE;
            }
            $query->whereIn('book', function ($q) use ($sourceId) {
                $q->select('book')->from('library')
                    ->whereIn('canonical_source_id', function ($qq) use ($sourceId) {
                        $qq->select('id')->from('canonical_source')
                            ->where('journal_source_id', $sourceId);
                    });
            });
        }

        $books = $query->orderBy('book')->pluck('book');
        if (($limit = (int) $this->option('limit')) > 0) {
            $books = $books->take($limit);
        }
        if ($books->isEmpty()) {
            $this->info('No books carry ambiguous citation links.');
            return self::SUCCESS;
        }

        $totals = ['ambiguous' => 0, 'applied' => 0, 'pending' => 0, 'stale_dropped' => 0];
        foreach ($books as $b) {
            $r = $registry->sync($b);
            foreach ($totals as $k => $_) {
                $totals[$k] += $r[$k] ?? 0;
            }
            $this->line(sprintf('  %s  ambiguous=%d applied=%d pending=%d',
                $b, $r['ambiguous'], $r['applied'], $r['pending']));
        }

        $this->newLine();
        $this->info(sprintf(
            '%d book(s): %d ambiguous link(s) — %d answered (re-applied), %d pending, %d stale dropped.',
            $books->count(), $totals['ambiguous'], $totals['applied'],
            $totals['pending'], $totals['stale_dropped'],
        ));
        $this->line('Review the pending ones at /maintainer/citations');

        return self::SUCCESS;
    }
}
