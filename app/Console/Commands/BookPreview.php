<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Book Preview - Preview Book at a Point in Time
 *
 * PURPOSE:
 * Shows what the book looked like at a specific point in time,
 * before deciding whether to restore to that version.
 *
 * USAGE:
 * php artisan book:preview {book} --at=1              # Preview 1 snapshot back
 * php artisan book:preview {book} --at=2              # Preview 2 snapshots back
 * php artisan book:preview {book} --at="2026-02-06"   # Preview at timestamp
 *
 * EXAMPLE:
 * php artisan book:preview my-book-id --at=3
 */
class BookPreview extends Command
{
    protected $signature = 'book:preview {book} {--at= : Snapshot number (1,2,3...) or timestamp}';
    protected $description = 'Preview what a book looked like at a specific point in time';

    public function handle()
    {
        $bookId = $this->argument('book');
        $atValue = $this->option('at');

        if (!$atValue) {
            $this->error("--at is required. Use a number (1,2,3...) or a timestamp.");
            $this->line("Example: php artisan book:preview {$bookId} --at=1");
            return 1;
        }

        // Resolve --at to a timestamp
        $resolved = $this->resolveTimestamp($bookId, $atValue);
        if (!$resolved) {
            return 1;
        }

        [$timestamp, $snapshotLabel] = $resolved;

        $this->newLine();
        $this->info("Book Preview: {$bookId}");
        $this->line("Timestamp: {$timestamp} ({$snapshotLabel})");
        $this->line(str_repeat('═', 70));

        // Get nodes as they were at that timestamp
        $nodes = DB::select("
            -- Current nodes that existed at that time
            SELECT
                node_id, \"startLine\", type, raw_json,
                LEFT(content, 100) as content_preview,
                'current' as source
            FROM nodes
            WHERE book = ?
            AND sys_period @> ?::timestamptz

            UNION ALL

            -- Historical nodes that were active at that time
            SELECT
                node_id, \"startLine\", type, raw_json,
                LEFT(content, 100) as content_preview,
                'history' as source
            FROM nodes_history
            WHERE book = ?
            AND sys_period @> ?::timestamptz

            ORDER BY \"startLine\"
        ", [$bookId, $timestamp, $bookId, $timestamp]);

        if (empty($nodes)) {
            $this->warn("No nodes found at this timestamp.");
            $this->line("The book may not have existed yet at this time.");
            return 1;
        }

        // Count by type
        $typeCounts = [];
        foreach ($nodes as $node) {
            $type = $node->type ?: 'unknown';
            $typeCounts[$type] = ($typeCounts[$type] ?? 0) + 1;
        }

        $this->newLine();
        $this->line("Nodes at this time: <fg=cyan>" . count($nodes) . "</>");

        $typeList = [];
        foreach ($typeCounts as $type => $count) {
            $typeList[] = "{$count} {$type}";
        }
        $this->line("Types: " . implode(', ', $typeList));

        // Compare to current
        $currentCount = DB::table('nodes')->where('book', $bookId)->count();
        $diff = count($nodes) - $currentCount;
        if ($diff > 0) {
            $this->line("Compared to now: <fg=green>+{$diff} nodes</> (historical version has more)");
        } elseif ($diff < 0) {
            $this->line("Compared to now: <fg=red>{$diff} nodes</> (historical version has fewer)");
        } else {
            $this->line("Compared to now: same node count");
        }

        // Show first N nodes
        $this->newLine();
        $this->line("First 15 nodes:");
        $this->line(str_repeat('─', 70));

        foreach (array_slice($nodes, 0, 15) as $index => $node) {
            $num = $index + 1;
            $type = $this->getNodeType($node);
            $type = str_pad(substr($type, 0, 10), 10); // Max 10 chars, padded

            $preview = $this->cleanPreview($node->content_preview);
            if (strlen($preview) > 40) {
                $preview = substr($preview, 0, 37) . '...';
            }

            $sourceIndicator = $node->source === 'history' ? '<fg=yellow>H</>' : '<fg=green>C</>';

            $this->line(sprintf(
                " %2d. [%s] %s %s",
                $num,
                $type,
                $preview,
                $sourceIndicator
            ));
        }

        if (count($nodes) > 15) {
            $this->line("     ... and " . (count($nodes) - 15) . " more nodes");
        }

        $this->newLine();
        $this->line("<fg=gray>C = still current, H = from history</>");

        $this->newLine();
        $this->line("To restore to this version:");
        $this->line("  <fg=cyan>php artisan book:restore {$bookId} --at=\"{$atValue}\" --dry-run</>");
        $this->line("  <fg=cyan>php artisan book:restore {$bookId} --at=\"{$atValue}\"</>");

        return 0;
    }

    /**
     * Resolve --at value to a timestamp
     * Accepts: number (1, 2, 3) or timestamp string
     */
    private function resolveTimestamp(string $bookId, string $atValue): ?array
    {
        // Check if it's a number (snapshot index)
        if (is_numeric($atValue) && (int)$atValue > 0) {
            $snapshotIndex = (int)$atValue;

            // Get the Nth snapshot timestamp
            $snapshots = DB::select("
                SELECT DISTINCT upper(sys_period) as changed_at
                FROM nodes_history
                WHERE book = ?
                AND upper(sys_period) IS NOT NULL
                ORDER BY upper(sys_period) DESC
                LIMIT ?
            ", [$bookId, $snapshotIndex]);

            if (count($snapshots) < $snapshotIndex) {
                $this->error("Snapshot #{$snapshotIndex} not found. Only " . count($snapshots) . " snapshots exist.");
                $this->line("Run: php artisan book:snapshots {$bookId}");
                return null;
            }

            // The timestamp we want is BEFORE the change occurred
            // So we use the changed_at timestamp minus a tiny bit
            $changedAt = $snapshots[$snapshotIndex - 1]->changed_at;

            // Query for nodes that were valid just before this change
            // We want the state AT the moment before upper(sys_period)
            // So we query for lower(sys_period) of that snapshot
            $timestamp = DB::selectOne("
                SELECT lower(sys_period) as valid_from
                FROM nodes_history
                WHERE book = ? AND upper(sys_period) = ?
                LIMIT 1
            ", [$bookId, $changedAt])?->valid_from;

            if (!$timestamp) {
                $timestamp = $changedAt; // fallback
            }

            return [$timestamp, "snapshot #{$snapshotIndex}"];
        }

        // Otherwise treat as timestamp
        return [$atValue, "explicit timestamp"];
    }

    /**
     * Clean HTML from preview text
     */
    private function cleanPreview(?string $content): string
    {
        if (!$content) {
            return '(empty)';
        }
        $text = strip_tags($content);
        $text = preg_replace('/\s+/', ' ', $text);
        return trim($text);
    }

    /**
     * Get node type from column or raw_json fallback
     */
    private function getNodeType($node): string
    {
        // Try column first
        if (!empty($node->type)) {
            return $node->type;
        }

        // Try raw_json
        if (!empty($node->raw_json)) {
            $json = is_string($node->raw_json) ? json_decode($node->raw_json, true) : $node->raw_json;
            if (!empty($json['type'])) {
                return $json['type'];
            }
        }

        return 'p'; // Default
    }
}
