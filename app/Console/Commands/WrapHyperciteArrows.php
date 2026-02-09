<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Models\PgNodeChunk;

class WrapHyperciteArrows extends Command
{
    protected $signature = 'hypercite:wrap-arrows {--dry-run : Show what would be changed without making changes}';
    protected $description = 'Wrap existing hypercite arrows in nowrap spans to prevent orphaning';

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

            // Pattern: find closing quote followed by anchor with hypercite
            // Old: '...'<a href="...#hypercite_..." id="hypercite_...">...<sup class="open-icon">↗</sup></a>
            // New: '...<span class="nowrap">'<a href="...#hypercite_..." id="hypercite_...">...<sup class="open-icon">↗</sup></a></span>

            // Skip if already wrapped
            if (str_contains($content, '<span class="nowrap">\'<a')) {
                $skipped++;
                continue;
            }

            // Match: closing quote + optional word joiner + anchor with sup.open-icon
            // The anchor ends with </a> and we need to wrap it with the preceding quote
            $pattern = '/\'(\x{2060})?(<a\s[^>]*href="[^"]*#hypercite_[^"]*"[^>]*>[\x{200B}]?<sup\s+class="open-icon">[^<]*<\/sup><\/a>)/u';

            $replacement = '<span class="nowrap">\'$2</span>';

            $newContent = preg_replace($pattern, $replacement, $content);

            if ($newContent !== $content) {
                if ($dryRun) {
                    $this->line("Would update node {$node->node_id} in book {$node->book}");
                    $this->line("  Before: " . substr($content, 0, 200) . '...');
                    $this->line("  After:  " . substr($newContent, 0, 200) . '...');
                } else {
                    $node->content = $newContent;

                    // Also update raw_json if it contains content
                    if ($node->raw_json && isset($node->raw_json['content'])) {
                        $rawJson = $node->raw_json;
                        $rawJson['content'] = $newContent;
                        $node->raw_json = $rawJson;
                    }

                    $node->save();
                }
                $updated++;
            }
        }

        $this->info("Updated: {$updated}, Skipped (already wrapped): {$skipped}");

        if ($dryRun && $updated > 0) {
            $this->info('Run without --dry-run to apply changes');
        }

        return Command::SUCCESS;
    }
}
