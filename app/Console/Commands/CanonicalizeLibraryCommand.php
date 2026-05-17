<?php

namespace App\Console\Commands;

use App\Models\PgLibrary;
use App\Services\CanonicalSourceMatcher;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Backfill / re-run the canonical-source matcher across the library.
 * See docs/canonical-sources.md.
 */
class CanonicalizeLibraryCommand extends Command
{
    protected $signature = 'library:canonicalize
                            {--book= : Process one library row by book id}
                            {--limit=0 : Max rows to process (0 = unlimited)}
                            {--missing-only : Skip rows that already have canonical_source_id}
                            {--force : Re-match even if canonical_source_id is already set}
                            {--dry-run : Do not write to the database}
                            {--sleep=0 : Seconds to sleep between rows (rate-limit cushion)}';

    protected $description = 'Match each library row to a canonical_source (existing row or OpenAlex API) and link them.';

    public function handle(CanonicalSourceMatcher $matcher): int
    {
        $bookId = $this->option('book') ?: null;
        $limit = (int) $this->option('limit');
        $missingOnly = (bool) $this->option('missing-only');
        $force = (bool) $this->option('force');
        $dryRun = (bool) $this->option('dry-run');
        $sleep = (int) $this->option('sleep');

        if ($force && $missingOnly) {
            $this->error('--force and --missing-only are mutually exclusive.');
            return 1;
        }

        // Use admin connection so RLS does not hide library rows from the backfill.
        $query = DB::connection('pgsql_admin')->table('library');

        if ($bookId) {
            $query->where('book', $bookId);
        } else {
            // Skip the synthetic listing rows that are not real books.
            $query->whereNotIn('book', ['stats', 'most-recent', 'most-connected', 'most-lit']);
            // Skip sub-books — canonical identity is for top-level works.
            $query->where('book', 'NOT LIKE', '%/%');

            if ($missingOnly) {
                $query->whereNull('canonical_source_id');
            }
        }

        $query->orderBy('book');

        $totalCandidates = (clone $query)->count();
        $this->info("Library rows in scope: {$totalCandidates}" . ($dryRun ? ' (dry-run)' : ''));

        if ($limit > 0) {
            $query->limit($limit);
        }

        $rows = $query->select('book')->get();
        $bar = $this->output->createProgressBar($rows->count());
        $bar->start();

        $stats = [
            CanonicalSourceMatcher::STATUS_ALREADY_LINKED  => 0,
            CanonicalSourceMatcher::STATUS_LINKED_EXISTING => 0,
            CanonicalSourceMatcher::STATUS_LINKED_NEW      => 0,
            CanonicalSourceMatcher::STATUS_NO_MATCH        => 0,
            'error'                                        => 0,
        ];

        $byMethod = [];
        $errorSamples = [];

        foreach ($rows as $row) {
            $library = PgLibrary::on('pgsql_admin')->where('book', $row->book)->first();
            if (!$library) {
                $bar->advance();
                continue;
            }

            try {
                $result = $matcher->match($library, force: $force, dryRun: $dryRun);
                $stats[$result['status']] = ($stats[$result['status']] ?? 0) + 1;
                if (!empty($result['method'])) {
                    $byMethod[$result['method']] = ($byMethod[$result['method']] ?? 0) + 1;
                }

                if ($this->getOutput()->isVerbose()) {
                    $bar->clear();
                    $score = $result['score'] !== null ? sprintf(' (%.2f)', $result['score']) : '';
                    $this->line("  {$row->book}: {$result['status']}{$score} — {$result['reason']}");
                    $bar->display();
                }
            } catch (\Throwable $e) {
                $stats['error']++;
                if (count($errorSamples) < 5) {
                    $errorSamples[] = "{$row->book}: " . $e->getMessage();
                }
            }

            $bar->advance();
            if ($sleep > 0) sleep($sleep);
        }

        $bar->finish();
        $this->newLine(2);

        $this->info('Summary:');
        foreach ($stats as $status => $count) {
            $this->line(sprintf('  %-20s %d', $status, $count));
        }
        if (!empty($byMethod)) {
            $this->info('By method:');
            foreach ($byMethod as $method => $count) {
                $this->line(sprintf('  %-30s %d', $method, $count));
            }
        }
        if (!empty($errorSamples)) {
            $this->warn('Sample errors:');
            foreach ($errorSamples as $err) {
                $this->line('  ' . $err);
            }
        }

        return 0;
    }
}
