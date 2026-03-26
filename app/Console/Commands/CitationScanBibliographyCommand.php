<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use App\Jobs\CitationScanBibliographyJob;

class CitationScanBibliographyCommand extends Command
{
    protected $signature = 'citation:scan-bibliography {target : bookId or bookId:referenceId to scan a single citation}
                            {--force : Clear existing matches and re-scan from scratch}';
    protected $description = 'Scan a book\'s bibliography and resolve citations via OpenAlex';

    public function handle(): int
    {
        $target = $this->argument('target');
        $db = DB::connection('pgsql_admin');

        // Parse target — "bookId:referenceId" for single citation, or just "bookId"
        $referenceId = null;
        if (str_contains($target, ':')) {
            [$bookId, $referenceId] = explode(':', $target, 2);
        } else {
            $bookId = $target;
        }

        // Check that the book exists
        $book = $db->table('library')->where('book', $bookId)->first();
        if (!$book) {
            $this->error("Book not found: {$bookId}");
            return 1;
        }

        $this->info("Book: {$book->title}");

        if ($referenceId) {
            // Verify the referenceId exists
            $entry = $db->table('bibliography')
                ->where('book', $bookId)
                ->where('referenceId', $referenceId)
                ->first();
            if (!$entry) {
                $this->error("Reference not found: {$referenceId}");
                return 1;
            }
            $this->info("Scanning single citation: {$referenceId}");
            $entryCount = 1;
        } else {
            $entryCount = $db->table('bibliography')->where('book', $bookId)->count();
            if ($entryCount === 0) {
                $this->warn('No bibliography entries found for this book.');
                return 0;
            }
            $this->info("Bibliography entries: {$entryCount}");
        }

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
        $force = (bool) $this->option('force');
        if ($force) {
            $this->warn('Force mode: clearing existing matches before re-scan.');
        }
        $this->info('Running scan...');
        CitationScanBibliographyJob::dispatch($scanId, $bookId, $referenceId, $force);

        // Fetch completed scan and print report
        $scan = $db->table('citation_scans')->where('id', $scanId)->first();

        if (!$scan) {
            $this->error('Scan record not found after dispatch.');
            return 1;
        }

        $this->newLine();
        $this->printSummary($scan);

        $results = json_decode($scan->results, true) ?? [];

        // Single citation: print inline. Full book: write to file.
        if ($referenceId && !empty($results)) {
            $this->newLine();
            foreach ($results as $r) {
                $this->printEntryDetail($r);
            }
        } elseif (!empty($results)) {
            $path = $this->writeMarkdownReport($scan, $results, $bookId);
            $this->newLine();
            $this->info("Full report: {$path}");
        }

        return $scan->status === 'failed' ? 1 : 0;
    }

    private function printEntryDetail(array $r): void
    {
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
        if (!empty($r['openalex_id'])) {
            $this->line("  OpenAlex ID:      {$r['openalex_id']}");
        }

        if ($r['status'] === 'no_match') {
            if (!empty($r['best_candidate'])) {
                $pct = isset($r['best_score']) ? ' (' . round($r['best_score'] * 100) . '%)' : '';
                $this->line("  Best candidate:   \"{$r['best_candidate']}\"{$pct} (rejected)");
            }
            if (!empty($r['rejected_type'])) {
                $this->line("  Rejected type:    {$r['rejected_type']} (non-citable)");
            }
        }

        if (!empty($r['llm_metadata'])) {
            $meta = $r['llm_metadata'];
            $this->line('  LLM metadata:');
            if (!empty($meta['title']))     $this->line("    Title:     {$meta['title']}");
            if (!empty($meta['authors']))   $this->line("    Authors:   " . implode('; ', $meta['authors']));
            if (!empty($meta['year']))      $this->line("    Year:      {$meta['year']}");
            if (!empty($meta['journal']))   $this->line("    Journal:   {$meta['journal']}");
            if (!empty($meta['publisher'])) $this->line("    Publisher: {$meta['publisher']}");
        }

        if (!empty($r['error'])) {
            $this->line("  Error:            {$r['error']}");
        }
    }

    private function printSummary(object $scan): void
    {
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
    }

    private function writeMarkdownReport(object $scan, array $results, string $bookId): string
    {
        $timestamp = now()->format('Y-m-d_His');
        $filename = "citation-scan_{$bookId}_{$timestamp}.md";

        $md = "# Citation Scan Report\n\n";
        $md .= "- **Book:** {$bookId}\n";
        $md .= "- **Status:** {$scan->status}\n";
        $md .= "- **Date:** " . now()->toDateTimeString() . "\n\n";
        $md .= "## Summary\n\n";
        $md .= "| Metric | Count |\n|--------|-------|\n";
        $md .= "| Total entries | {$scan->total_entries} |\n";
        $md .= "| Newly resolved | {$scan->newly_resolved} |\n";
        $md .= "| Enriched existing | {$scan->enriched_existing} |\n";
        $md .= "| Already linked | {$scan->already_linked} |\n";
        $md .= "| Failed to resolve | {$scan->failed_to_resolve} |\n\n";

        // Group results by status
        $grouped = [];
        foreach ($results as $r) {
            $grouped[$r['status']][] = $r;
        }

        // Resolved entries
        if (!empty($grouped['newly_resolved'])) {
            $md .= "## Newly Resolved (" . count($grouped['newly_resolved']) . ")\n\n";
            foreach ($grouped['newly_resolved'] as $r) {
                $md .= $this->formatEntryMd($r);
            }
        }

        // Enriched entries
        if (!empty($grouped['enriched'])) {
            $md .= "## Enriched (" . count($grouped['enriched']) . ")\n\n";
            foreach ($grouped['enriched'] as $r) {
                $md .= $this->formatEntryMd($r);
            }
        }

        // No match entries
        if (!empty($grouped['no_match'])) {
            $md .= "## No Match (" . count($grouped['no_match']) . ")\n\n";
            foreach ($grouped['no_match'] as $r) {
                $md .= $this->formatEntryMd($r);
            }
        }

        // Errors
        if (!empty($grouped['error'])) {
            $md .= "## Errors (" . count($grouped['error']) . ")\n\n";
            foreach ($grouped['error'] as $r) {
                $md .= $this->formatEntryMd($r);
            }
        }

        // Already linked (just count)
        if (!empty($grouped['already_linked'])) {
            $md .= "## Already Linked (" . count($grouped['already_linked']) . ")\n\n";
            $md .= "These entries already had `foundation_source` set — skipped.\n\n";
        }

        Storage::put($filename, $md);

        return storage_path("app/{$filename}");
    }

    private function formatEntryMd(array $r): string
    {
        $status = match ($r['status']) {
            'newly_resolved' => 'RESOLVED',
            'enriched'       => 'ENRICHED',
            'no_match'       => 'NO MATCH',
            'error'          => 'ERROR',
            default          => strtoupper($r['status']),
        };

        $md = "### `{$r['referenceId']}`\n\n";

        if (!empty($r['searched_title'])) {
            $md .= "- **Searched for:** \"{$r['searched_title']}\"\n";
        }
        if (!empty($r['result_title'])) {
            $md .= "- **OpenAlex result:** \"{$r['result_title']}\"\n";
        }
        if (!empty($r['match_method'])) {
            $md .= "- **Match method:** {$r['match_method']}\n";
        }
        if (isset($r['similarity_score'])) {
            $pct = round($r['similarity_score'] * 100);
            $md .= "- **Similarity:** {$r['similarity_score']} ({$pct}%)\n";
        }
        if (!empty($r['openalex_id'])) {
            $md .= "- **OpenAlex ID:** {$r['openalex_id']}\n";
        }

        // No-match details
        if ($r['status'] === 'no_match') {
            if (!empty($r['best_candidate'])) {
                $pct = isset($r['best_score']) ? ' (' . round($r['best_score'] * 100) . '%)' : '';
                $md .= "- **Best candidate (rejected):** \"{$r['best_candidate']}\"{$pct}\n";
            }
            if (!empty($r['rejected_type'])) {
                $md .= "- **Rejected type:** {$r['rejected_type']} (non-citable)\n";
            }
        }

        // LLM metadata if present
        if (!empty($r['llm_metadata'])) {
            $meta = $r['llm_metadata'];
            $md .= "- **LLM metadata:**\n";
            if (!empty($meta['title']))     $md .= "  - Title: {$meta['title']}\n";
            if (!empty($meta['authors']))   $md .= "  - Authors: " . implode('; ', $meta['authors']) . "\n";
            if (!empty($meta['year']))      $md .= "  - Year: {$meta['year']}\n";
            if (!empty($meta['journal']))   $md .= "  - Journal: {$meta['journal']}\n";
            if (!empty($meta['publisher'])) $md .= "  - Publisher: {$meta['publisher']}\n";
        }

        if (!empty($r['error'])) {
            $md .= "- **Error:** {$r['error']}\n";
        }

        $md .= "\n";
        return $md;
    }
}
