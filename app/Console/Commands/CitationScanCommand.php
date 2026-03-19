<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use App\Jobs\CitationScanJob;

class CitationScanCommand extends Command
{
    protected $signature = 'citation:scan {bookId}';
    protected $description = 'Scan a book\'s bibliography and resolve citations via OpenAlex';

    public function handle(): int
    {
        $bookId = $this->argument('bookId');
        $db = DB::connection('pgsql_admin');

        // Check that the book exists
        $book = $db->table('library')->where('book', $bookId)->first();
        if (!$book) {
            $this->error("Book not found: {$bookId}");
            return 1;
        }

        $this->info("Book: {$book->title}");

        // Count bibliography entries
        $entryCount = $db->table('bibliography')->where('book', $bookId)->count();
        if ($entryCount === 0) {
            $this->warn('No bibliography entries found for this book.');
            return 0;
        }

        $this->info("Bibliography entries: {$entryCount}");
        $this->newLine();

        // Create scan record
        $scanId = (string) Str::uuid();
        $db->table('citation_scans')->insert([
            'id'            => $scanId,
            'book'          => $bookId,
            'status'        => 'pending',
            'total_entries' => $entryCount,
            'created_at'    => now(),
            'updated_at'    => now(),
        ]);

        // Dispatch the job (runs synchronously with QUEUE_CONNECTION=sync)
        $this->info('Running scan...');
        CitationScanJob::dispatch($scanId, $bookId);

        // Fetch completed scan and print report
        $scan = $db->table('citation_scans')->where('id', $scanId)->first();

        if (!$scan) {
            $this->error('Scan record not found after dispatch.');
            return 1;
        }

        $this->newLine();
        $this->printReport($scan);

        return $scan->status === 'failed' ? 1 : 0;
    }

    private function printReport(object $scan): void
    {
        // Summary
        $statusStyle = match ($scan->status) {
            'completed' => 'fg=green',
            'failed'    => 'fg=red',
            default     => 'fg=yellow',
        };
        $this->line("<{$statusStyle}>Status: {$scan->status}</>");

        $this->line("  Total entries:      {$scan->total_entries}");
        $this->line("  Newly resolved:     {$scan->newly_resolved}");
        $this->line("  Enriched existing:  {$scan->enriched_existing}");
        $this->line("  Already linked:     {$scan->already_linked}");
        $this->line("  Failed to resolve:  {$scan->failed_to_resolve}");

        if ($scan->error) {
            $this->error("Error: {$scan->error}");
        }

        // Per-entry report card
        $results = json_decode($scan->results, true);
        if (empty($results)) {
            return;
        }

        $this->newLine();
        $this->info('--- Per-entry report ---');

        foreach ($results as $i => $r) {
            $num = $i + 1;
            $this->newLine();
            $this->line("#{$num} [{$r['referenceId']}]");

            $statusLabel = match ($r['status']) {
                'newly_resolved' => '<fg=green>RESOLVED</>',
                'enriched'       => '<fg=cyan>ENRICHED</>',
                'already_linked' => '<fg=yellow>SKIPPED (already linked)</>',
                'no_match'       => '<fg=red>NO MATCH</>',
                'error'          => '<fg=red>ERROR</>',
                default          => $r['status'],
            };
            $this->line("  Status:           {$statusLabel}");

            if (!empty($r['searched_title'])) {
                $this->line("  Searched for:     \"{$r['searched_title']}\"");
            }

            if (!empty($r['result_title'])) {
                $this->line("  OpenAlex result:  \"{$r['result_title']}\"");
            }

            if (!empty($r['match_method'])) {
                $this->line("  Match method:     {$r['match_method']}");
            }

            if (isset($r['similarity_score'])) {
                $pct = round($r['similarity_score'] * 100);
                $this->line("  Similarity:       {$r['similarity_score']} ({$pct}%)");
            }

            // For no_match, show what the best candidate was (even though it was rejected)
            if ($r['status'] === 'no_match') {
                if (!empty($r['best_candidate'])) {
                    $this->line("  Best candidate:   \"{$r['best_candidate']}\" (rejected)");
                }
                if (isset($r['best_score'])) {
                    $pct = round($r['best_score'] * 100);
                    $this->line("  Best score:       {$r['best_score']} ({$pct}%)");
                }
                if (!empty($r['rejected_type'])) {
                    $this->line("  Rejected type:    {$r['rejected_type']} (non-citable)");
                }
            }

            if (!empty($r['openalex_id'])) {
                $this->line("  OpenAlex ID:      {$r['openalex_id']}");
            }

            if (!empty($r['error'])) {
                $this->line("  Error:            {$r['error']}");
            }
        }

        $this->newLine();
    }
}
