<?php

namespace App\Console\Commands;

use App\Jobs\QueueBookEmbeddings;
use App\Services\EmbeddingEligibility;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class ReconcileEmbeddings extends Command
{
    protected $signature = 'embeddings:reconcile
        {--dry-run : Report what would happen without dispatching or scrubbing}
        {--max-books= : Cap how many missing-coverage books get dispatched this run}';

    protected $description = 'Converge embeddings to the eligibility definition: queue missing ones, scrub stray ones';

    /**
     * The reconciliation sweep the event-driven embedding system was missing
     * (2026-08 audit): every dispatch site has to remember to fire, and every
     * miss — a path with no dispatch, a 3-strikes API failure, an edit that
     * nulled a stale vector — was permanent. This runs on a schedule
     * (routes/console.php) and converges both directions:
     *
     *   MISSING — books with >= 1 eligible node lacking an embedding get a
     *   QueueBookEmbeddings dispatch (low-priority 'embeddings' queue, so a
     *   big backlog never blocks imports).
     *
     *   STRAY — embeddings on INELIGIBLE books (generated card-list books a
     *   backfill over-reached, books that became sub-books, orphans) are
     *   nulled: they pollute AI-brain retrieval and pay storage for vectors
     *   no query should return. E2EE scrubbing is NOT this command's job
     *   (setEncryption does it transactionally) but it backstops that too.
     */
    public function handle(): int
    {
        $admin = DB::connection('pgsql_admin');
        $dryRun = (bool) $this->option('dry-run');
        $bookSql = EmbeddingEligibility::bookSql('l');
        $nodeSql = EmbeddingEligibility::nodeSql('n');

        // MISSING: eligible books with unembedded eligible nodes.
        $missingQuery = $admin->table('nodes AS n')
            ->join('library AS l', 'n.book', '=', 'l.book')
            ->whereNull('n.embedding')
            ->whereRaw($bookSql)
            ->whereRaw($nodeSql)
            ->groupBy('n.book')
            ->selectRaw('n.book, count(*) AS missing')
            ->orderByDesc('missing');

        if ($max = $this->option('max-books')) {
            $missingQuery->limit((int) $max);
        }

        $missing = $missingQuery->get();
        $missingNodes = $missing->sum('missing');

        foreach ($missing as $row) {
            if (!$dryRun) {
                QueueBookEmbeddings::dispatch($row->book);
            }
        }
        $this->info(($dryRun ? '[dry-run] would dispatch' : 'Dispatched') . " QueueBookEmbeddings for {$missing->count()} books ({$missingNodes} nodes missing embeddings)");

        // STRAY: vectors on ineligible books (NOT bookSql) or on orphan nodes
        // whose book has no library row at all.
        $strayWhere = "embedding IS NOT NULL AND ("
            . "NOT EXISTS (SELECT 1 FROM library l WHERE l.book = nodes.book)"
            . " OR EXISTS (SELECT 1 FROM library l WHERE l.book = nodes.book AND NOT {$bookSql})"
            . ")";

        if ($dryRun) {
            $strayCount = (int) ($admin->selectOne("SELECT count(*) AS c FROM nodes WHERE {$strayWhere}")->c ?? 0);
            $this->info("[dry-run] would scrub {$strayCount} stray embeddings");
        } else {
            $scrubbed = $admin->update("UPDATE nodes SET embedding = NULL WHERE {$strayWhere}");
            $this->info("Scrubbed {$scrubbed} stray embeddings");
        }

        return Command::SUCCESS;
    }
}
