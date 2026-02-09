<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class ConvertHyperciteFormat extends Command
{
    protected $signature = 'hypercite:convert-format {--dry-run : Show what would be changed without making changes}';
    protected $description = 'Convert hypercites to word joiner format (remove spans, add word joiner before anchors)';

    public function handle()
    {
        $dryRun = $this->option('dry-run');

        if ($dryRun) {
            $this->info('DRY RUN - no changes will be made');
        }

        // Find all nodes containing hypercite anchors using admin connection (bypasses RLS)
        $nodes = DB::connection('pgsql_admin')->table('nodes')
            ->where('content', 'like', '%#hypercite_%')
            ->where('content', 'like', '%open-icon%')
            ->get();

        $this->info("Found {$nodes->count()} nodes with hypercite arrows");

        $updated = 0;
        $skipped = 0;

        foreach ($nodes as $node) {
            $content = $node->content;
            $originalContent = $content;

            // Step 1: Remove any <span class="nowrap"> wrappers
            $content = preg_replace('/<span class="nowrap">(.+?)<\/span>/u', '$1', $content);

            // Step 2: Remove zero-width spaces from inside hypercite anchors (legacy cleanup)
            // These can cause unwanted line breaks
            $content = preg_replace('/(<a\s[^>]*href="[^"]*#hypercite_[^"]*"[^>]*>)\x{200B}/u', '$1', $content);

            // Step 3: Add word joiner before hypercite anchors (if not already present)
            // Match: <a ...href="...#hypercite_..."...> NOT preceded by word joiner
            $content = preg_replace('/(?<!\x{2060})(<a\s[^>]*href="[^"]*#hypercite_[^"]*"[^>]*>)/u', "\u{2060}$1", $content);

            if ($content !== $originalContent) {
                if ($dryRun) {
                    $this->line("Would update node {$node->node_id} in book {$node->book}");
                    $this->line("  Before: " . substr($originalContent, 0, 300));
                    $this->line("  After:  " . substr($content, 0, 300));
                    $this->line("");
                } else {
                    // Update raw_json if it contains content
                    $rawJson = json_decode($node->raw_json, true);
                    $updatedRawJson = $node->raw_json;
                    if ($rawJson && is_array($rawJson) && isset($rawJson['content'])) {
                        $rawJson['content'] = $content;
                        $updatedRawJson = json_encode($rawJson);
                    }

                    // Use raw UPDATE with admin connection to bypass RLS
                    DB::connection('pgsql_admin')->statement(
                        'UPDATE nodes SET content = ?, raw_json = ?::jsonb, updated_at = ? WHERE book = ? AND "startLine" = ?',
                        [
                            $content,
                            $updatedRawJson,
                            now(),
                            $node->book,
                            $node->startLine,
                        ]
                    );
                }
                $updated++;
            } else {
                $skipped++;
            }
        }

        $this->info("Updated: {$updated}, Skipped (already correct): {$skipped}");

        if ($dryRun && $updated > 0) {
            $this->info('Run without --dry-run to apply changes');
        }

        return Command::SUCCESS;
    }
}
