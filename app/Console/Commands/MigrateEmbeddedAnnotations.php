<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Migrate Embedded Annotations to Normalized Tables
 *
 * PURPOSE:
 * Migrates hyperlights and hypercites from OLD embedded arrays in node_chunks.hyperlights
 * and node_chunks.hypercites columns to NEW normalized schema with node_id and charData fields
 * in the hyperlights and hypercites tables.
 *
 * WHY THIS IS NEEDED:
 * - OLD SYSTEM: Annotations stored as embedded JSON arrays in each node_chunks row
 * - NEW SYSTEM: Annotations in normalized tables with node_id array and charData object
 * - This allows efficient querying, cross-node annotations, and proper hydration
 *
 * STRATEGY:
 * - Two-pass approach for safety:
 *   Pass 1: Migrate annotations with empty/null charData only
 *   Pass 2: Report annotations with BOTH embedded data AND charData (manual review)
 *
 * USAGE:
 * php artisan migrate:embedded-annotations {book} --dry-run   # Preview changes
 * php artisan migrate:embedded-annotations {book} --force     # Execute migration
 *
 * EXAMPLE:
 * php artisan migrate:embedded-annotations book_1760156814805 --dry-run
 * php artisan migrate:embedded-annotations book_1760156814805 --force
 *
 * SAFETY:
 * - Requires --force flag to execute (prevents accidental runs)
 * - Dry-run mode shows all changes without writing
 * - Uses database transaction (all-or-nothing)
 * - Only touches annotations with empty charData (won't corrupt NEW system data)
 * - Can be run multiple times safely (idempotent)
 */
class MigrateEmbeddedAnnotations extends Command
{
    protected $signature = 'migrate:embedded-annotations {book?} {--all} {--dry-run} {--force}';
    protected $description = 'Migrate embedded hyperlights/hypercites to normalized charData schema';

    public function handle()
    {
        $book = $this->argument('book');
        $all = $this->option('all');
        $dryRun = $this->option('dry-run');
        $force = $this->option('force');

        if (!$book && !$all) {
            $this->error('❌ You must specify either a book ID or use --all flag');
            $this->error('   Usage: migrate:embedded-annotations {book} --force');
            $this->error('   Usage: migrate:embedded-annotations --all --force');
            return 1;
        }

        if ($book && $all) {
            $this->error('❌ Cannot use both book argument and --all flag');
            return 1;
        }

        if (!$dryRun && !$force) {
            $this->error('❌ This command requires --force flag to execute.');
            $this->error('   Use --dry-run to preview changes first.');
            return 1;
        }

        $this->warn('⚠️  IMPORTANT: Backup your database before running this command!');
        $this->newLine();

        if (!$dryRun && !$this->confirm('Have you backed up your database?')) {
            $this->info('Migration cancelled.');
            return 0;
        }

        if ($all) {
            return $this->migrateAllBooks($dryRun);
        }

        $this->info("Processing book: {$book}");
        $this->info($dryRun ? 'Mode: DRY RUN (no changes will be made)' : 'Mode: LIVE MIGRATION');
        $this->newLine();

        DB::beginTransaction();

        try {
            // Pass 1: Migrate empty charData
            $this->info('=== PASS 1: Migrating Empty charData ===');
            $migratedCount = $this->migrateEmptyCharData($book, $dryRun);

            // Pass 2: Report conflicts
            $this->newLine();
            $this->info('=== PASS 2: Reporting Conflicts ===');
            $conflictCount = $this->reportConflicts($book);

            // Summary
            $this->newLine();
            $this->info('=== SUMMARY ===');
            $this->info("Migrated: {$migratedCount['hyperlights']} hyperlights, {$migratedCount['hypercites']} hypercites");
            $this->info("Conflicts (skipped): {$conflictCount['hyperlights']} hyperlights, {$conflictCount['hypercites']} hypercites");

            if ($dryRun) {
                DB::rollBack();
                $this->warn('✅ Dry run complete - no changes made');
            } else {
                DB::commit();
                $this->info('✅ Migration complete!');
            }

            return 0;

        } catch (\Exception $e) {
            DB::rollBack();
            $this->error("❌ Migration failed: " . $e->getMessage());
            $this->error($e->getTraceAsString());
            return 1;
        }
    }

    private function migrateEmptyCharData(string $book, bool $dryRun): array
    {
        // Find annotations needing migration (empty charData)
        $emptyHighlights = DB::table('hyperlights')
            ->where('book', $book)
            ->where(function($q) {
                $q->whereNull('charData')
                  ->orWhere('charData', '{}')
                  ->orWhere('charData', '[]');
            })
            ->pluck('hyperlight_id')
            ->toArray();

        $emptyHypercites = DB::table('hypercites')
            ->where('book', $book)
            ->where(function($q) {
                $q->whereNull('charData')
                  ->orWhere('charData', '{}')
                  ->orWhere('charData', '[]');
            })
            ->pluck('hyperciteId')
            ->toArray();

        $this->info("Found " . count($emptyHighlights) . " hyperlights needing migration");
        $this->info("Found " . count($emptyHypercites) . " hypercites needing migration");
        $this->newLine();

        if (empty($emptyHighlights) && empty($emptyHypercites)) {
            $this->warn('No annotations need migration!');
            return ['hyperlights' => 0, 'hypercites' => 0];
        }

        // Get all chunks with embedded data (ordered by startLine)
        $chunks = DB::table('nodes')
            ->where('book', $book)
            ->whereNotNull('node_id')
            ->where(function($q) {
                $q->whereNotNull('hyperlights')
                  ->orWhereNotNull('hypercites');
            })
            ->orderBy('startLine', 'asc')
            ->get();

        // Collect embedded data grouped by annotation ID
        $hyperlightData = [];
        $hyperciteData = [];

        $bar = $this->output->createProgressBar(count($chunks));
        $bar->start();

        foreach ($chunks as $chunk) {
            $nodeUuid = $chunk->node_id;

            if (!$nodeUuid) {
                $this->warn("\nWarning: Chunk {$chunk->startLine} has no node_id - skipping");
                continue;
            }

            // Process hyperlights
            $hls = json_decode($chunk->hyperlights ?? '[]', true) ?: [];
            foreach ($hls as $hl) {
                $hlId = $hl['highlightID'] ?? null;
                if (!$hlId || !in_array($hlId, $emptyHighlights)) continue;

                if (!isset($hyperlightData[$hlId])) {
                    $hyperlightData[$hlId] = [
                        'nodes' => [],
                        'charData' => []
                    ];
                }

                $hyperlightData[$hlId]['nodes'][] = $nodeUuid;
                $hyperlightData[$hlId]['charData'][$nodeUuid] = [
                    'charStart' => $hl['charStart'] ?? 0,
                    'charEnd' => $hl['charEnd'] ?? 0
                ];
            }

            // Process hypercites
            $hcs = json_decode($chunk->hypercites ?? '[]', true) ?: [];
            foreach ($hcs as $hc) {
                $hcId = $hc['hyperciteId'] ?? null;
                if (!$hcId || !in_array($hcId, $emptyHypercites)) continue;

                if (!isset($hyperciteData[$hcId])) {
                    $hyperciteData[$hcId] = [
                        'nodes' => [],
                        'charData' => []
                    ];
                }

                $hyperciteData[$hcId]['nodes'][] = $nodeUuid;
                $hyperciteData[$hcId]['charData'][$nodeUuid] = [
                    'charStart' => $hc['charStart'] ?? 0,
                    'charEnd' => $hc['charEnd'] ?? 0
                ];
            }

            $bar->advance();
        }

        $bar->finish();
        $this->newLine(2);

        // Update hyperlights
        foreach ($hyperlightData as $hlId => $data) {
            $uniqueNodes = array_values(array_unique($data['nodes']));

            $this->info("Migrating HL {$hlId}:");
            $this->info("  → " . count($uniqueNodes) . " nodes: " . implode(', ', array_slice($uniqueNodes, 0, 3)) . (count($uniqueNodes) > 3 ? '...' : ''));
            $this->info("  → charData keys: " . implode(', ', array_keys($data['charData'])));

            if (!$dryRun) {
                DB::table('hyperlights')
                    ->where('book', $book)
                    ->where('hyperlight_id', $hlId)
                    ->update([
                        'node_id' => json_encode($uniqueNodes),
                        'charData' => json_encode($data['charData'])
                    ]);
            }
        }

        // Update hypercites
        foreach ($hyperciteData as $hcId => $data) {
            $uniqueNodes = array_values(array_unique($data['nodes']));

            $this->info("Migrating HC {$hcId}:");
            $this->info("  → " . count($uniqueNodes) . " nodes: " . implode(', ', array_slice($uniqueNodes, 0, 3)) . (count($uniqueNodes) > 3 ? '...' : ''));
            $this->info("  → charData keys: " . implode(', ', array_keys($data['charData'])));

            if (!$dryRun) {
                DB::table('hypercites')
                    ->where('book', $book)
                    ->where('hyperciteId', $hcId)
                    ->update([
                        'node_id' => json_encode($uniqueNodes),
                        'charData' => json_encode($data['charData'])
                    ]);
            }
        }

        return [
            'hyperlights' => count($hyperlightData),
            'hypercites' => count($hyperciteData)
        ];
    }

    private function reportConflicts(string $book): array
    {
        // Find annotations with BOTH embedded data AND existing charData
        $chunks = DB::table('nodes')
            ->where('book', $book)
            ->whereNotNull('node_id')
            ->where(function($q) {
                $q->whereNotNull('hyperlights')
                  ->orWhereNotNull('hypercites');
            })
            ->get();

        $hlConflicts = [];
        $hcConflicts = [];

        foreach ($chunks as $chunk) {
            // Check hyperlights
            $hls = json_decode($chunk->hyperlights ?? '[]', true) ?: [];
            foreach ($hls as $hl) {
                $hlId = $hl['highlightID'] ?? null;
                if (!$hlId) continue;

                $existing = DB::table('hyperlights')
                    ->where('book', $book)
                    ->where('hyperlight_id', $hlId)
                    ->first();

                if ($existing && !empty($existing->charData) && $existing->charData !== '{}' && $existing->charData !== '[]') {
                    $hlConflicts[$hlId] = true;
                }
            }

            // Check hypercites
            $hcs = json_decode($chunk->hypercites ?? '[]', true) ?: [];
            foreach ($hcs as $hc) {
                $hcId = $hc['hyperciteId'] ?? null;
                if (!$hcId) continue;

                $existing = DB::table('hypercites')
                    ->where('book', $book)
                    ->where('hyperciteId', $hcId)
                    ->first();

                if ($existing && !empty($existing->charData) && $existing->charData !== '{}' && $existing->charData !== '[]') {
                    $hcConflicts[$hcId] = true;
                }
            }
        }

        if (!empty($hlConflicts) || !empty($hcConflicts)) {
            $this->warn('Found annotations with BOTH embedded data AND charData:');
            foreach (array_keys($hlConflicts) as $hlId) {
                $this->warn("  - {$hlId} (hyperlight - skipped)");
            }
            foreach (array_keys($hcConflicts) as $hcId) {
                $this->warn("  - {$hcId} (hypercite - skipped)");
            }
            $this->warn('⚠️  These were skipped. Manual review recommended.');
        } else {
            $this->info('No conflicts found!');
        }

        return [
            'hyperlights' => count($hlConflicts),
            'hypercites' => count($hcConflicts)
        ];
    }

    /**
     * Migrate all books in the library
     */
    private function migrateAllBooks(bool $dryRun): int
    {
        // Get all books from library table
        $books = DB::table('library')->pluck('book')->toArray();

        if (empty($books)) {
            $this->warn('No books found in library table');
            return 0;
        }

        $this->info("Found " . count($books) . " books to migrate:");
        $this->newLine();

        // Show list of books
        foreach (array_slice($books, 0, 10) as $book) {
            $this->line("  - {$book}");
        }
        if (count($books) > 10) {
            $this->line("  ... and " . (count($books) - 10) . " more");
        }
        $this->newLine();

        if (!$dryRun && !$this->confirm('Proceed with migration?', true)) {
            $this->info('Migration cancelled.');
            return 0;
        }

        // Track results
        $results = [
            'success' => [],
            'failed' => [],
            'total_hyperlights' => 0,
            'total_hypercites' => 0,
            'total_conflicts' => 0
        ];

        $this->info($dryRun ? 'Mode: DRY RUN (no changes will be made)' : 'Mode: LIVE MIGRATION');
        $this->newLine();

        // Progress bar for books
        $bar = $this->output->createProgressBar(count($books));
        $bar->setFormat('very_verbose');
        $bar->start();

        foreach ($books as $book) {
            try {
                DB::beginTransaction();

                // Pass 1: Migrate empty charData
                $migratedCount = $this->migrateEmptyCharData($book, $dryRun);

                // Pass 2: Report conflicts
                $conflictCount = $this->reportConflicts($book);

                if ($dryRun) {
                    DB::rollBack();
                } else {
                    DB::commit();
                }

                $results['success'][] = $book;
                $results['total_hyperlights'] += $migratedCount['hyperlights'];
                $results['total_hypercites'] += $migratedCount['hypercites'];
                $results['total_conflicts'] += $conflictCount['hyperlights'] + $conflictCount['hypercites'];

            } catch (\Exception $e) {
                DB::rollBack();
                $results['failed'][] = [
                    'book' => $book,
                    'error' => $e->getMessage()
                ];
            }

            $bar->advance();
        }

        $bar->finish();
        $this->newLine(2);

        // Show summary
        $this->info('=== MIGRATION SUMMARY ===');
        $this->info("Successfully processed: " . count($results['success']) . " books");
        $this->info("Failed: " . count($results['failed']) . " books");
        $this->info("Total migrated: {$results['total_hyperlights']} hyperlights, {$results['total_hypercites']} hypercites");
        $this->info("Total conflicts: {$results['total_conflicts']}");

        if (!empty($results['failed'])) {
            $this->newLine();
            $this->error('=== FAILED BOOKS ===');
            foreach ($results['failed'] as $failure) {
                $this->error("  {$failure['book']}: {$failure['error']}");
            }
        }

        $this->newLine();
        if ($dryRun) {
            $this->warn('✅ Dry run complete - no changes made');
        } else {
            $this->info('✅ Migration complete!');
        }

        return count($results['failed']) > 0 ? 1 : 0;
    }
}
