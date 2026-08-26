<?php

namespace App\Console\Commands;

use App\Models\PgLibrary;
use App\Models\PgNode;
use App\Services\BookCache;
// NOTE: all queries run on the BYPASSRLS `pgsql_admin` connection — the CLI has
// no app.current_user session var, so default-connection reads under RLS
// silently see a subset (the queue-worker billing no-op class of bug).
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Strip the RETIRED `no-delete-id="please"` marker from stored content.
 *
 * The marker was the old "book can never be emptied" anchor: stamped into one
 * node's HTML per book (client- AND server-side) and persisted, i.e. app state
 * stored inside user content. It is retired — the invariant is now a runtime
 * check (resources/js/divEditor/keydownGuards/lastNodeGuard.ts + the
 * chunkMutationHandler book-empty backstop) and nothing reads the attribute —
 * but stale copies live on in `nodes.content` and in the
 * `footnotes.preview_nodes` / `hyperlights.preview_nodes` JSON blobs.
 * Residual markers are harmless (the client refresh-skip comparator
 * normalizes them), so this sweep is hygiene, not a hotfix.
 *
 * E2EE books are SKIPPED: their content is ciphertext, the marker sits inside
 * the plaintext, and no server-side rewrite can touch it. The client-side
 * normalizer tolerates those forever.
 *
 * Unlike the older content:strip-mark-tags precedent, this command also does
 * the two things a bulk content rewrite must do: bump `library.timestamp` for
 * every touched book (so open readers learn about the change — the client's
 * marker-normalized diff then skips the visible refresh) and invalidate the
 * BookCache directory (stale chunk files would keep serving the marker).
 *
 * USAGE:
 * php artisan content:strip-no-delete-markers                  # all books
 * php artisan content:strip-no-delete-markers {book}           # one book
 * php artisan content:strip-no-delete-markers {book} --dry-run # preview
 */
class StripNoDeleteMarkers extends Command
{
    protected $signature = 'content:strip-no-delete-markers {book?} {--dry-run}';

    protected $description = 'Remove the retired no-delete-id marker from nodes.content and preview_nodes blobs (skips E2EE books; bumps timestamps + busts BookCache)';

    /** The exact attribute text as it appears inside stored HTML. */
    private const MARKER = ' no-delete-id="please"';

    public function handle(BookCache $cache)
    {
        $book = $this->argument('book');
        $dryRun = $this->option('dry-run');

        if ($dryRun) {
            $this->info('🔍 DRY RUN MODE - No changes will be made');
        }

        // E2EE books hold ciphertext — unsweepable and excluded.
        $encryptedBooks = PgLibrary::on('pgsql_admin')->where('encrypted', true)->pluck('book')->all();
        if ($encryptedBooks !== []) {
            $this->info('🔐 Skipping ' . count($encryptedBooks) . ' encrypted book(s)');
        }

        $nodesQuery = PgNode::on('pgsql_admin')->where('content', 'LIKE', '%no-delete-id%')
            ->when($book, fn ($q) => $q->where('book', $book))
            ->when($encryptedBooks !== [], fn ($q) => $q->whereNotIn('book', $encryptedBooks));

        $affectedNodes = $nodesQuery->get();

        $previewTargets = [];
        foreach (['footnotes', 'hyperlights'] as $table) {
            $previewTargets[$table] = DB::connection('pgsql_admin')->table($table)
                ->whereRaw("preview_nodes::text LIKE '%no-delete-id%'")
                ->when($book, fn ($q) => $q->where('book', $book))
                ->when($encryptedBooks !== [], fn ($q) => $q->whereNotIn('book', $encryptedBooks))
                ->pluck('book')
                ->all();
        }

        $touchedBooks = collect($affectedNodes->pluck('book'))
            ->merge($previewTargets['footnotes'])
            ->merge($previewTargets['hyperlights'])
            ->unique()
            ->values();

        $this->info("Found {$affectedNodes->count()} node(s), "
            . count($previewTargets['footnotes']) . ' footnote preview blob(s), '
            . count($previewTargets['hyperlights']) . ' hyperlight preview blob(s) '
            . "across {$touchedBooks->count()} book(s)");

        if ($touchedBooks->isEmpty()) {
            $this->info('✅ No no-delete-id markers found!');
            return 0;
        }

        if ($dryRun) {
            $this->newLine();
            $this->info('📋 Sample of affected nodes:');
            foreach ($affectedNodes->take(5) as $node) {
                $this->line("  Book: {$node->book} | Line: {$node->startLine}");
            }
            $this->newLine();
            $this->warn('⚠️  To actually clean the data, run without --dry-run flag');
            return 0;
        }

        if (! $this->confirm("Strip markers across {$touchedBooks->count()} book(s)?", true)) {
            $this->info('❌ Cancelled');
            return 1;
        }

        // 1. nodes.content — plain text replace via the model (matches the
        //    content:strip-mark-tags loop shape).
        $bar = $this->output->createProgressBar($affectedNodes->count());
        $bar->start();
        $cleaned = 0;
        foreach ($affectedNodes as $node) {
            $node->content = str_replace(self::MARKER, '', $node->content);
            $node->save();
            $cleaned++;
            $bar->advance();
        }
        $bar->finish();
        $this->newLine();
        $this->info("✅ Cleaned {$cleaned} node(s)");

        // 2. preview_nodes jsonb — inside JSON text the embedded quotes are
        //    backslash-escaped, so the needle is ` no-delete-id=\"please\"`.
        $jsonNeedle = ' no-delete-id=\\"please\\"';
        foreach (['footnotes', 'hyperlights'] as $table) {
            $updated = DB::connection('pgsql_admin')->table($table)
                ->whereRaw("preview_nodes::text LIKE '%no-delete-id%'")
                ->when($book, fn ($q) => $q->where('book', $book))
                ->when($encryptedBooks !== [], fn ($q) => $q->whereNotIn('book', $encryptedBooks))
                ->update([
                    'preview_nodes' => DB::raw(
                        'replace(preview_nodes::text, ' . DB::connection('pgsql_admin')->getPdo()->quote($jsonNeedle) . ", '')::jsonb"
                    ),
                ]);
            $this->info("✅ Cleaned {$updated} {$table} preview blob(s)");
        }

        // 3. Per touched book: advance library.timestamp so open clients learn
        //    of the change (their marker-normalized diff makes the refresh
        //    invisible), and bust the BookCache so stale chunk files can't
        //    keep serving the marker.
        $nowMs = (int) round(microtime(true) * 1000);
        foreach ($touchedBooks as $touched) {
            DB::connection('pgsql_admin')->table('library')->where('book', $touched)->update([
                'timestamp' => DB::raw('GREATEST(' . $nowMs . ', COALESCE(timestamp, 0) + 1)'),
            ]);
            $cache->invalidate($touched);
        }
        $this->info("✅ Bumped timestamps + invalidated BookCache for {$touchedBooks->count()} book(s)");

        return 0;
    }
}
