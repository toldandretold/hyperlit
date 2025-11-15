<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Renumber Book Nodes - Force Clean Slate
 *
 * PURPOSE:
 * Renumbers all nodes in a book with clean 100-unit gaps and recalculates chunk_ids.
 * This fixes any inconsistencies in startLine values and chunk_id assignments.
 *
 * WHAT IT DOES:
 * 1. Gets all nodes for a book, ordered by current startLine
 * 2. Renumbers them: 100, 200, 300, 400...
 * 3. Recalculates chunk_id: floor(index / 100) → 0, 1, 2, 3...
 * 4. Updates content to match new IDs
 * 5. Preserves node_id (stable identifier)
 *
 * USAGE:
 * php artisan nodes:renumber {book}             # Renumber specific book
 * php artisan nodes:renumber {book} --dry-run   # Preview changes
 *
 * EXAMPLE:
 * php artisan nodes:renumber book_1760156814805 --dry-run
 */
class RenumberBookNodes extends Command
{
    protected $signature = 'nodes:renumber {book} {--dry-run}';
    protected $description = 'Force renumber all nodes in a book with clean IDs and chunk_ids';

    public function handle()
    {
        $bookId = $this->argument('book');
        $dryRun = $this->option('dry-run');

        if ($dryRun) {
            $this->info('🔍 DRY RUN MODE - No changes will be made');
        }

        $this->info("Renumbering book: {$bookId}");

        // Get all chunks ordered by startLine
        $chunks = DB::table('nodes')
            ->where('book', $bookId)
            ->orderBy('startLine')
            ->get();

        if ($chunks->isEmpty()) {
            $this->error("No nodes found for book: {$bookId}");
            return 1;
        }

        $totalCount = $chunks->count();
        $this->info("Found {$totalCount} nodes");

        // Show current state sample
        $this->newLine();
        $this->info('📋 Current state (first 10 nodes):');
        foreach ($chunks->take(10) as $index => $chunk) {
            $this->line("  [{$index}] startLine: {$chunk->startLine}, chunk_id: {$chunk->chunk_id}");
        }

        // Calculate new values
        $updates = [];
        $nodesPerChunk = 100;

        foreach ($chunks as $index => $chunk) {
            $newStartLine = ($index + 1) * 100; // 100, 200, 300...
            $chunkIndex = floor($index / $nodesPerChunk);
            $newChunkId = $chunkIndex; // 0, 1, 2...

            // Update content's id attribute to match new startLine
            $updatedContent = preg_replace(
                '/id="[\d.]+"/i',
                'id="' . $newStartLine . '"',
                $chunk->content
            );

            // Update raw_json
            $rawJson = json_decode($chunk->raw_json, true);
            if ($rawJson && is_array($rawJson)) {
                $rawJson['content'] = $updatedContent;
                $rawJson['startLine'] = $newStartLine;
                $rawJson['chunk_id'] = $newChunkId;
                $updatedRawJson = json_encode($rawJson);
            } else {
                $updatedRawJson = $chunk->raw_json;
            }

            $updates[] = [
                'book' => $chunk->book,
                'old_startLine' => $chunk->startLine,
                'new_startLine' => $newStartLine,
                'old_chunk_id' => $chunk->chunk_id,
                'new_chunk_id' => $newChunkId,
                'node_id' => $chunk->node_id,
                'content' => $updatedContent,
                'raw_json' => $updatedRawJson,
                // Preserve all other columns
                'hyperlights' => $chunk->hyperlights,
                'hypercites' => $chunk->hypercites,
                'footnotes' => $chunk->footnotes,
                'created_at' => $chunk->created_at,
                'updated_at' => $chunk->updated_at
            ];
        }

        // Show new state sample
        $this->newLine();
        $this->info('📋 New state (first 10 nodes):');
        foreach (array_slice($updates, 0, 10) as $index => $update) {
            $this->line("  [{$index}] startLine: {$update['old_startLine']} → {$update['new_startLine']}, chunk_id: {$update['old_chunk_id']} → {$update['new_chunk_id']}");
        }

        if ($dryRun) {
            $this->newLine();
            $this->warn('⚠️  To actually renumber, run without --dry-run flag');
            return 0;
        }

        // Confirm
        $this->newLine();
        if (!$this->confirm("Renumber {$totalCount} nodes?", true)) {
            $this->info('❌ Cancelled');
            return 1;
        }

        // Apply updates - just UPDATE the three columns we care about
        $this->info('🔄 Renumbering nodes...');
        $bar = $this->output->createProgressBar($totalCount);
        $bar->start();

        DB::beginTransaction();

        try {
            // Update each node with new startLine, chunk_id, and content
            foreach ($updates as $update) {
                DB::table('nodes')
                    ->where('book', $update['book'])
                    ->where('startLine', $update['old_startLine'])
                    ->update([
                        'startLine' => $update['new_startLine'],
                        'chunk_id' => $update['new_chunk_id'],
                        'content' => $update['content'],
                        'raw_json' => DB::raw("'" . str_replace("'", "''", $update['raw_json']) . "'::jsonb"),
                        'updated_at' => now()
                    ]);

                $bar->advance();
            }

            DB::commit();
            $bar->finish();
            $this->newLine(2);
            $this->info("✅ Successfully renumbered {$totalCount} nodes");

        } catch (\Exception $e) {
            DB::rollBack();
            $bar->finish();
            $this->newLine(2);
            $this->error("❌ Error: " . $e->getMessage());
            return 1;
        }

        return 0;
    }
}
