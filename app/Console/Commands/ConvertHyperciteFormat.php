<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Models\PgNodeChunk;

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

        // Find all nodes containing hypercite anchors
        $nodes = PgNodeChunk::where('content', 'like', '%#hypercite_%')
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

            // Step 2: Add word joiner before hypercite anchors (if not already present)
            // Match: <a ...href="...#hypercite_..."...> NOT preceded by word joiner
            $content = preg_replace('/(?<!\x{2060})(<a\s[^>]*href="[^"]*#hypercite_[^"]*"[^>]*>)/u', "\u{2060}$1", $content);

            if ($content !== $originalContent) {
                if ($dryRun) {
                    $this->line("Would update node {$node->node_id} in book {$node->book}");
                    $this->line("  Before: " . substr($originalContent, 0, 300));
                    $this->line("  After:  " . substr($content, 0, 300));
                    $this->line("");
                } else {
                    $node->content = $content;

                    // Also update raw_json if it contains content
                    if ($node->raw_json && isset($node->raw_json['content'])) {
                        $rawJson = $node->raw_json;
                        $rawJson['content'] = $content;
                        $node->raw_json = $rawJson;
                    }

                    $node->save();
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
