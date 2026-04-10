<?php

namespace App\Console\Commands;

use App\Services\EmbeddingService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class BackfillEmbeddings extends Command
{
    protected $signature = 'embeddings:backfill
        {--batch-size=100 : Number of nodes to process per batch}
        {--book= : Only backfill a specific book ID}
        {--limit= : Maximum number of nodes to process}';

    protected $description = 'Backfill vector embeddings for existing nodes';

    public function handle(EmbeddingService $embeddingService): int
    {
        $batchSize = (int) $this->option('batch-size');
        $bookFilter = $this->option('book');
        $limit = $this->option('limit') ? (int) $this->option('limit') : null;
        $processed = 0;
        $embedded = 0;
        $skipped = 0;

        // Prevent query log from eating all memory over 40k+ iterations
        DB::disableQueryLog();
        DB::connection('pgsql_admin')->disableQueryLog();

        $this->info('Starting embedding backfill...');

        // Use admin connection to bypass RLS (artisan has no user context)
        $query = DB::connection('pgsql_admin')->table('nodes AS n')
            ->join('library AS l', 'n.book', '=', 'l.book')
            ->select('n.id', 'n.plainText', 'n.book')
            ->whereNull('n.embedding')
            ->where('l.visibility', 'public')
            ->where('l.type', '!=', 'sub_book')
            ->orderBy('n.id');

        if ($bookFilter) {
            $query->where('n.book', $bookFilter);
        }

        if ($limit) {
            $query->limit($limit);
        }

        $total = (clone $query)->count();
        $this->info("Found {$total} nodes to embed.");

        $bar = $this->output->createProgressBar($total);
        $bar->start();

        $query->chunkById($batchSize, function ($nodes) use ($embeddingService, &$processed, &$embedded, &$skipped, $bar) {
            $textsToEmbed = [];
            $nodeMap = [];

            foreach ($nodes as $node) {
                $processed++;

                if (empty($node->plainText) || strlen(trim($node->plainText)) < 20) {
                    $skipped++;
                    $bar->advance();
                    continue;
                }

                $textsToEmbed[] = 'search_document: ' . $node->plainText;
                $nodeMap[] = $node;
            }

            if (empty($textsToEmbed)) {
                return;
            }

            $embeddings = $embeddingService->embedBatch($textsToEmbed);

            foreach ($embeddings as $idx => $embedding) {
                if ($embedding && isset($nodeMap[$idx])) {
                    $vectorStr = '[' . implode(',', $embedding) . ']';
                    DB::connection('pgsql_admin')->table('nodes')
                        ->where('id', $nodeMap[$idx]->id)
                        ->update(['embedding' => DB::raw("'{$vectorStr}'::vector")]);
                    $embedded++;
                }
                $bar->advance();
            }

            // Brief pause between batches to avoid rate limits
            usleep(100_000);

            // Free memory between batches
            gc_collect_cycles();
        }, 'n.id', 'id');

        $bar->finish();
        $this->newLine(2);
        $this->info("Done! Processed: {$processed}, Embedded: {$embedded}, Skipped: {$skipped}");

        return Command::SUCCESS;
    }
}
