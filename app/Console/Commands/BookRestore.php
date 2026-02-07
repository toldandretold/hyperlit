<?php

namespace App\Console\Commands;

use App\Models\PgNodeChunk;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Book Restore - Restore Book to a Previous Version
 *
 * PURPOSE:
 * Restores an entire book to a specific point in time.
 * The current state is archived to history before restoring.
 *
 * USAGE:
 * php artisan book:restore {book} --at=1 --dry-run    # Preview what would change
 * php artisan book:restore {book} --at=1              # Restore 1 snapshot back
 * php artisan book:restore {book} --at="2026-02-06"   # Restore to timestamp
 *
 * EXAMPLE:
 * php artisan book:restore my-book-id --at=3
 */
class BookRestore extends Command
{
    protected $signature = 'book:restore {book} {--at= : Snapshot number (1,2,3...) or timestamp} {--dry-run : Preview changes without applying}';
    protected $description = 'Restore a book to a previous version';

    public function handle()
    {
        $bookId = $this->argument('book');
        $atValue = $this->option('at');
        $dryRun = $this->option('dry-run');

        if (!$atValue) {
            $this->error("--at is required. Use a number (1,2,3...) or a timestamp.");
            $this->line("Example: php artisan book:restore {$bookId} --at=1 --dry-run");
            return 1;
        }

        // Resolve --at to a timestamp
        $resolved = $this->resolveTimestamp($bookId, $atValue);
        if (!$resolved) {
            return 1;
        }

        [$timestamp, $snapshotLabel] = $resolved;

        if ($dryRun) {
            $this->newLine();
            $this->warn("DRY RUN - No changes will be made");
        }

        $this->newLine();
        $this->info("Book Restore: {$bookId}");
        $this->line("Target: {$timestamp} ({$snapshotLabel})");
        $this->line(str_repeat('═', 70));

        // Get current nodes
        $currentNodes = DB::table('nodes')
            ->where('book', $bookId)
            ->get()
            ->keyBy('node_id');

        // Get historical nodes at that timestamp
        // Note: must explicitly list columns because nodes has generated columns that history doesn't
        $historicalNodes = collect(DB::select("
            -- Current nodes that existed at that time
            SELECT
                id, raw_json, book, chunk_id, \"startLine\", footnotes,
                content, \"plainText\", type, created_at, updated_at,
                node_id, sys_period
            FROM nodes
            WHERE book = ?
            AND sys_period @> ?::timestamptz

            UNION ALL

            -- Historical nodes that were active at that time
            SELECT
                id, raw_json, book, chunk_id, \"startLine\", footnotes,
                content, \"plainText\", type, created_at, updated_at,
                node_id, sys_period
            FROM nodes_history
            WHERE book = ?
            AND sys_period @> ?::timestamptz
        ", [$bookId, $timestamp, $bookId, $timestamp]))->keyBy('node_id');

        if ($historicalNodes->isEmpty()) {
            $this->error("No nodes found at timestamp: {$timestamp}");
            $this->line("The book may not have existed at this time.");
            return 1;
        }

        // Calculate what would change
        $currentNodeIds = $currentNodes->keys()->all();
        $historicalNodeIds = $historicalNodes->keys()->all();

        $toDelete = array_diff($currentNodeIds, $historicalNodeIds);
        $toCreate = array_diff($historicalNodeIds, $currentNodeIds);
        $toUpdate = array_intersect($currentNodeIds, $historicalNodeIds);

        // Check which updates actually have changes
        $actualUpdates = [];
        foreach ($toUpdate as $nodeId) {
            $current = $currentNodes->get($nodeId);
            $historical = $historicalNodes->get($nodeId);

            // Compare content (main thing that matters)
            if ($current->content !== $historical->content) {
                $actualUpdates[] = $nodeId;
            }
        }

        $this->newLine();
        $this->line("Current state:  <fg=cyan>" . count($currentNodes) . " nodes</>");
        $this->line("Target state:   <fg=cyan>" . count($historicalNodes) . " nodes</>");

        $this->newLine();
        $this->line("Changes to be made:");
        $this->line("  <fg=red>- " . count($toDelete) . " nodes will be deleted</> (not in historical version)");
        $this->line("  <fg=green>+ " . count($toCreate) . " nodes will be recreated</> (were deleted after this time)");
        $this->line("  <fg=yellow>~ " . count($actualUpdates) . " nodes will be updated</> (content changed)");
        $this->line("  <fg=gray>= " . (count($toUpdate) - count($actualUpdates)) . " nodes unchanged</>");

        if ($dryRun) {
            $this->newLine();

            // Show some details about what would change
            if (!empty($toDelete)) {
                $this->line("Nodes to delete:");
                foreach (array_slice($toDelete, 0, 5) as $nodeId) {
                    $node = $currentNodes->get($nodeId);
                    $type = $this->getNodeType($node);
                    $preview = $this->cleanPreview($node->content, 40);
                    $this->line("  <fg=red>- [{$type}] {$preview}</>");
                }
                if (count($toDelete) > 5) {
                    $this->line("  ... and " . (count($toDelete) - 5) . " more");
                }
            }

            if (!empty($toCreate)) {
                $this->line("Nodes to recreate:");
                foreach (array_slice($toCreate, 0, 5) as $nodeId) {
                    $node = $historicalNodes->get($nodeId);
                    $type = $this->getNodeType($node);
                    $preview = $this->cleanPreview($node->content, 40);
                    $this->line("  <fg=green>+ [{$type}] {$preview}</>");
                }
                if (count($toCreate) > 5) {
                    $this->line("  ... and " . (count($toCreate) - 5) . " more");
                }
            }

            $this->newLine();
            $this->warn("Run without --dry-run to apply changes.");
            return 0;
        }

        // Confirm
        $this->newLine();
        $totalChanges = count($toDelete) + count($toCreate) + count($actualUpdates);
        if (!$this->confirm("Apply {$totalChanges} changes to restore book?", false)) {
            $this->info("Cancelled.");
            return 1;
        }

        // Execute restore
        $this->newLine();
        $this->info("Restoring book...");

        DB::beginTransaction();

        try {
            $bar = $this->output->createProgressBar($totalChanges);
            $bar->start();

            // Delete nodes that shouldn't exist
            foreach ($toDelete as $nodeId) {
                // The DELETE will trigger archiving via the versioning trigger
                DB::table('nodes')
                    ->where('book', $bookId)
                    ->where('node_id', $nodeId)
                    ->delete();
                $bar->advance();
            }

            // Update nodes with historical content
            foreach ($actualUpdates as $nodeId) {
                $historical = $historicalNodes->get($nodeId);

                // The UPDATE will trigger archiving via the versioning trigger
                DB::table('nodes')
                    ->where('book', $bookId)
                    ->where('node_id', $nodeId)
                    ->update([
                        'startLine' => $historical->startLine,
                        'chunk_id' => $historical->chunk_id,
                        'content' => $historical->content,
                        'plainText' => $historical->plainText,
                        'type' => $historical->type,
                        'raw_json' => $historical->raw_json,
                        'footnotes' => $historical->footnotes,
                        'updated_at' => now(),
                    ]);
                $bar->advance();
            }

            // Recreate deleted nodes
            foreach ($toCreate as $nodeId) {
                $historical = $historicalNodes->get($nodeId);

                // Parse JSON fields if needed
                $rawJson = is_string($historical->raw_json)
                    ? $historical->raw_json
                    : json_encode($historical->raw_json);
                $footnotes = is_string($historical->footnotes)
                    ? $historical->footnotes
                    : json_encode($historical->footnotes ?? []);

                DB::table('nodes')->insert([
                    'book' => $historical->book,
                    'node_id' => $historical->node_id,
                    'startLine' => $historical->startLine,
                    'chunk_id' => $historical->chunk_id,
                    'content' => $historical->content,
                    'plainText' => $historical->plainText,
                    'type' => $historical->type,
                    'raw_json' => $rawJson,
                    'footnotes' => $footnotes,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
                $bar->advance();
            }

            DB::commit();
            $bar->finish();

            $this->newLine(2);
            $this->info("✓ Book restored to {$timestamp} ({$snapshotLabel})");
            $this->line("  - " . count($historicalNodes) . " nodes now in book");
            $this->line("  - Previous state archived in nodes_history");

        } catch (\Exception $e) {
            DB::rollBack();
            $this->newLine(2);
            $this->error("✗ Restore failed: " . $e->getMessage());
            return 1;
        }

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
            // So we query for the state that was valid at that time
            $changedAt = $snapshots[$snapshotIndex - 1]->changed_at;

            // Get the valid_from of nodes that were changed at this time
            // This gives us the timestamp of the state before the change
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
    private function cleanPreview(?string $content, int $maxLength = 50): string
    {
        if (!$content) {
            return '(empty)';
        }
        $text = strip_tags($content);
        $text = preg_replace('/\s+/', ' ', $text);
        $text = trim($text);

        if (strlen($text) > $maxLength) {
            $text = substr($text, 0, $maxLength - 3) . '...';
        }

        return $text;
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
