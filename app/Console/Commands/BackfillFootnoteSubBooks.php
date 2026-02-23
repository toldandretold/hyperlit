<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Backfill footnote sub-books for footnotes created before the sub-book system.
 *
 * PURPOSE:
 * Footnotes created before the sub-book system only have plain text in the
 * footnotes.content column — no library record, no nodes, no preview_nodes.
 * When a non-owner opens one of these footnotes, subBookLoader.js synthesises
 * a local node and fires createSubBookOnBackend, which returns 403.
 *
 * This command materialises every unmigrated footnote as a proper sub-book
 * (library record + node) and writes preview_nodes back to the footnote row.
 * After running, every opener finds previewNodes and skips the backend call.
 *
 * All writes go through the pgsql_admin connection (rolbypassrls = true) so
 * row-level security policies are not a blocker.
 *
 * USAGE:
 * php artisan footnotes:backfill-sub-books              # Run migration
 * php artisan footnotes:backfill-sub-books --dry-run    # Preview without changes
 *
 * IDEMPOTENT: Safe to re-run. Footnotes that already have preview_nodes are
 * skipped. Footnotes with nodes but no preview_nodes get preview_nodes refreshed.
 */
class BackfillFootnoteSubBooks extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'footnotes:backfill-sub-books
                            {--dry-run : Preview what would be migrated without making changes}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Backfill sub-book library records and nodes for pre-existing footnotes';

    /** @var \Illuminate\Database\Connection */
    private $admin;

    /**
     * Execute the console command.
     */
    public function handle(): int
    {
        $dryRun = $this->option('dry-run');
        $this->admin = DB::connection('pgsql_admin');

        if ($dryRun) {
            $this->info('DRY RUN MODE — No changes will be made');
        }

        // Read via admin so RLS does not hide any rows.
        $footnotes = $this->admin
            ->table('footnotes')
            ->whereNotNull('content')
            ->where('content', '!=', '')
            ->whereNull('preview_nodes')
            ->get();

        $total = $footnotes->count();

        if ($total === 0) {
            $this->info('No footnotes need backfilling.');
            return 0;
        }

        $this->info("Found {$total} footnote(s) to process.");

        if ($dryRun) {
            $this->newLine();
            $this->table(
                ['book', 'footnoteId', 'content (truncated)'],
                $footnotes->take(10)->map(fn($f) => [
                    $f->book,
                    $f->footnoteId,
                    substr(strip_tags($f->content), 0, 60),
                ])->toArray()
            );
            if ($total > 10) {
                $this->line("  ... and " . ($total - 10) . " more");
            }
            $this->newLine();
            $this->warn('To run the migration, remove --dry-run');
            return 0;
        }

        $created   = 0;
        $skipped   = 0;
        $refreshed = 0;
        $errors    = 0;

        $bar = $this->output->createProgressBar($total);
        $bar->start();

        foreach ($footnotes as $footnote) {
            try {
                $subBookId = $footnote->book . '/' . $footnote->footnoteId;

                // Look up parent library for creator info (admin read).
                $library = $this->admin
                    ->table('library')
                    ->where('book', $footnote->book)
                    ->first();

                if (!$library) {
                    $this->newLine();
                    $this->warn("Skipping {$subBookId}: parent library not found for book '{$footnote->book}'");
                    $skipped++;
                    $bar->advance();
                    continue;
                }

                // If nodes already exist, just refresh preview_nodes and move on.
                $existingNode = $this->admin->table('nodes')->where('book', $subBookId)->first();
                if ($existingNode) {
                    $this->refreshPreviewNodes($subBookId, $footnote->book, $footnote->footnoteId);
                    $refreshed++;
                    $bar->advance();
                    continue;
                }

                // Upsert library record (inherits creator from parent book).
                $this->admin->table('library')->updateOrInsert(
                    ['book' => $subBookId],
                    [
                        'creator'       => $library->creator,
                        'creator_token' => $library->creator_token,
                        'visibility'    => $library->visibility,
                        'listed'        => false,
                        'title'         => "Annotation: {$footnote->footnoteId}",
                        'type'          => 'sub_book',
                        'has_nodes'     => true,
                        'raw_json'      => json_encode([]),
                        'updated_at'    => now(),
                        'created_at'    => now(),
                    ]
                );

                // Create initial node (strip HTML tags, wrap in standard format).
                $uuid      = (string) Str::uuid();
                $plainText = strip_tags($footnote->content);
                $content   = '<p data-node-id="' . e($uuid) . '" no-delete-id="please" '
                           . 'style="min-height:1.5em;">' . e($plainText) . '</p>';

                $this->admin->table('nodes')->insert([
                    'book'       => $subBookId,
                    'chunk_id'   => 0,
                    'startLine'  => 1,
                    'node_id'    => $uuid,
                    'content'    => $content,
                    'plainText'  => $plainText,
                    'raw_json'   => json_encode([]),
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);

                // Write preview_nodes to the footnote row using the new node.
                $previewNodes = [[
                    'book'        => $subBookId,
                    'chunk_id'    => 0,
                    'startLine'   => 1.0,
                    'node_id'     => $uuid,
                    'content'     => $content,
                    'footnotes'   => [],
                    'hyperlights' => [],
                    'hypercites'  => [],
                ]];

                $this->admin->table('footnotes')
                    ->where('book', $footnote->book)
                    ->where('footnoteId', $footnote->footnoteId)
                    ->update(['preview_nodes' => json_encode($previewNodes)]);

                $created++;
            } catch (\Exception $e) {
                $errors++;
                $this->newLine();
                $this->error("Error processing {$footnote->book}/{$footnote->footnoteId}: {$e->getMessage()}");
            }

            $bar->advance();
        }

        $bar->finish();
        $this->newLine(2);

        $this->info("Created: {$created}, Refreshed: {$refreshed}, Skipped: {$skipped}, Errors: {$errors}");

        return $errors > 0 ? 1 : 0;
    }

    /**
     * Rebuild preview_nodes for a sub-book that already has nodes.
     * Reads the first node and writes an enriched JSON array back to the footnote row.
     */
    private function refreshPreviewNodes(string $subBookId, string $parentBook, string $footnoteId): void
    {
        $nodeRows = $this->admin
            ->table('nodes')
            ->where('book', $subBookId)
            ->orderBy('startLine')
            ->limit(5)
            ->get();

        if ($nodeRows->isEmpty()) {
            return;
        }

        $nodeIds = $nodeRows->pluck('node_id')->filter()->toArray();

        // Fetch enrichment data (hyperlights/hypercites touching these nodes).
        $hyperlightsByNode = [];
        $hypercitesByNode  = [];

        if (!empty($nodeIds)) {
            $hyperlights = $this->admin->table('hyperlights')
                ->where('book', $subBookId)
                ->where('hidden', false)
                ->get();

            foreach ($hyperlights as $hl) {
                $hlNodeIds = json_decode($hl->node_id ?? '[]', true);
                $charData  = json_decode($hl->charData  ?? '{}', true);

                foreach ($hlNodeIds as $nid) {
                    if (!in_array($nid, $nodeIds)) continue;
                    $nodeCharData = $charData[$nid] ?? null;
                    if (!$nodeCharData) continue;

                    $hyperlightsByNode[$nid][] = [
                        'highlightID'   => $hl->hyperlight_id,
                        'charStart'     => $nodeCharData['charStart'],
                        'charEnd'       => $nodeCharData['charEnd'],
                        'annotation'    => $hl->annotation,
                        'preview_nodes' => $hl->preview_nodes ? json_decode($hl->preview_nodes, true) : null,
                        'time_since'    => $hl->time_since,
                        'hidden'        => false,
                        'is_user_highlight' => true,
                    ];
                }
            }

            $hypercites = $this->admin->table('hypercites')
                ->where('book', $subBookId)
                ->get();

            foreach ($hypercites as $hc) {
                $hcNodeIds = json_decode($hc->node_id ?? '[]', true);
                $charData  = json_decode($hc->charData  ?? '{}', true);

                foreach ($hcNodeIds as $nid) {
                    if (!in_array($nid, $nodeIds)) continue;
                    $nodeCharData = $charData[$nid] ?? null;
                    if (!$nodeCharData) continue;

                    $hypercitesByNode[$nid][] = [
                        'hyperciteId'        => $hc->hyperciteId,
                        'charStart'          => $nodeCharData['charStart'],
                        'charEnd'            => $nodeCharData['charEnd'],
                        'relationshipStatus' => $hc->relationshipStatus,
                        'citedIN'            => json_decode($hc->citedIN ?? '[]', true),
                        'time_since'         => $hc->time_since,
                    ];
                }
            }
        }

        $previewNodes = $nodeRows->map(fn($node) => [
            'book'        => $node->book,
            'chunk_id'    => (int) $node->chunk_id,
            'startLine'   => (float) $node->startLine,
            'node_id'     => $node->node_id,
            'content'     => $node->content,
            'footnotes'   => json_decode($node->footnotes ?? '[]', true),
            'hyperlights' => array_values($hyperlightsByNode[$node->node_id] ?? []),
            'hypercites'  => array_values($hypercitesByNode[$node->node_id]  ?? []),
        ])->toArray();

        $this->admin->table('footnotes')
            ->where('book', $parentBook)
            ->where('footnoteId', $footnoteId)
            ->update(['preview_nodes' => json_encode($previewNodes)]);
    }
}
