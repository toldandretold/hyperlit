<?php

namespace App\Console\Commands;

use App\Models\PgLibrary;
use App\Services\CanonicalSourceMatcher;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * One-off cleanup: pre-PR4 the citation search wrote OpenAlex/Open Library hits as
 * `library` stub rows (creator='OpenAlex', has_nodes=false). Post-PR4 those rows
 * are written to `canonical_source` instead. This command migrates the old stubs
 * into canonical_source and deletes the dangling library rows, rewriting any
 * bibliography records that pointed at them.
 *
 * Idempotent — safe to re-run. Always runs through CanonicalSourceMatcher so the
 * identifier-first dedup logic stays consistent with the live ingest path.
 *
 * Test coverage: tests/Feature/Citations/StubBackfillTest.php
 *   — Deletes orphaned stubs, creates canonicals, rewrites bibliography
 *     pointers, idempotent on second run, dry-run is read-only, --limit
 *     respects the cap.
 */
class BackfillCitationStubsCommand extends Command
{
    protected $signature = 'library:backfill-citation-stubs
                            {--limit=0 : Max rows to process (0 = unlimited)}
                            {--dry-run : Report what would change, write nothing}';

    protected $description = 'Migrate orphan OpenAlex/Open Library library stubs into canonical_source and clean up the library table.';

    public function handle(CanonicalSourceMatcher $matcher): int
    {
        $limit  = (int) $this->option('limit');
        $dryRun = (bool) $this->option('dry-run');

        // pgsql_admin: RLS would hide stubs created by other users.
        $query = DB::connection('pgsql_admin')->table('library')
            ->whereIn('creator', ['OpenAlex', 'OpenLibrary'])
            ->where('has_nodes', false)
            ->whereNull('canonical_source_id');

        if ($limit > 0) {
            $query->limit($limit);
        }

        $rows = $query->get();
        $this->info("Found {$rows->count()} stub rows to backfill" . ($dryRun ? ' (dry-run)' : ''));

        $stats = ['matched' => 0, 'created' => 0, 'no_match' => 0, 'bibliography_rewrites' => 0, 'deleted' => 0, 'errors' => 0];

        foreach ($rows as $row) {
            try {
                $library = PgLibrary::on('pgsql_admin')->where('book', $row->book)->first();
                if (!$library) {
                    $stats['errors']++;
                    continue;
                }

                // Force=true because we want to (re-)match even though canonical_source_id is null.
                $result = $matcher->match($library, force: true, dryRun: $dryRun);
                $status = $result['status'];

                if ($status === CanonicalSourceMatcher::STATUS_NO_MATCH) {
                    $stats['no_match']++;
                    $this->line("  no_match: {$row->book} — \"" . substr($row->title ?? '', 0, 60) . "\"");
                    continue;
                }

                if ($status === CanonicalSourceMatcher::STATUS_LINKED_NEW) {
                    $stats['created']++;
                } else {
                    $stats['matched']++;
                }

                if ($dryRun) {
                    continue;
                }

                // Rewrite any bibliography records that pointed at this library stub:
                // set canonical_source_id, null out source_id (which no longer resolves).
                $canonicalId = $result['canonical_source_id'];
                $updated = DB::connection('pgsql_admin')->table('bibliography')
                    ->where('source_id', $row->book)
                    ->update([
                        'source_id'           => null,
                        'canonical_source_id' => $canonicalId,
                        'updated_at'          => now(),
                    ]);
                $stats['bibliography_rewrites'] += $updated;

                // Delete the now-redundant library stub.
                DB::connection('pgsql_admin')->table('library')
                    ->where('book', $row->book)
                    ->delete();
                $stats['deleted']++;
            } catch (\Throwable $e) {
                $stats['errors']++;
                $this->error("  error on {$row->book}: " . $e->getMessage());
            }
        }

        $this->newLine();
        $this->info('Summary:');
        foreach ($stats as $k => $v) {
            $this->line("  {$k}: {$v}");
        }

        return 0;
    }
}
