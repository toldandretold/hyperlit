<?php

namespace App\Services\CitationReview\Import;

use App\Helpers\SubBookIdHelper;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Publishes the review markdown as the /{bookId}/AIreview sub-book: writes the
 * markdown, runs it through the document pipeline (streamed nodes.jsonl), clears
 * the old sub-book nodes, upserts the library row, saves the renumbered nodes,
 * and emits nodes.json for the editor saver.
 *
 * Extracted verbatim from CitationReviewService::importReportAsSubBook.
 */
final class ReportSubBookImporter
{
    public function __construct(
        private MarkdownProcessor $markdownProcessor,
        private FileHelpers $helpers,
    ) {}

    public function importReportAsSubBook(string $md, string $bookId, string $bookTitle): string
    {
        $subBookId = SubBookIdHelper::build($bookId, 'AIreview');
        $safeDir = str_replace('/', '_', $subBookId);
        $path = resource_path("markdown/{$safeDir}");

        // Write markdown
        File::ensureDirectoryExists($path);
        File::put("{$path}/original.md", $md);

        // Clean stale outputs from previous runs
        foreach (['nodes.json', 'nodes.jsonl', 'footnotes.json', 'footnotes.jsonl', 'audit.json', 'references.json', 'intermediate.html', 'notify_email.json'] as $f) {
            if (File::exists("{$path}/{$f}")) {
                File::delete("{$path}/{$f}");
            }
        }

        // Convert markdown → HTML → nodes
        $this->markdownProcessor->process("{$path}/original.md", $path, $subBookId);

        // Wait for nodes.jsonl — the pipeline's streamed output format.
        // (nodes.json is a renumbered artifact WE write during the save below;
        // waiting on it here failed every report import after the pipeline
        // moved to jsonl — same bug as ContentFetchService::processLocalPdf.)
        $nodesPath = "{$path}/nodes.jsonl";
        $attempts = 0;
        while (!File::exists($nodesPath) && $attempts < 15) {
            sleep(2);
            $attempts++;
        }
        if (!File::exists($nodesPath)) {
            throw new \RuntimeException("nodes.jsonl was not generated at {$nodesPath}");
        }

        // Use admin connection to bypass RLS (CLI has no authenticated user session)
        $db = DB::connection('pgsql_admin');

        // Clear old sub-book nodes
        $db->table('nodes')->where('book', $subBookId)->delete();

        // Create/update library record — inherit creator from parent
        $parent = $db->table('library')->where('book', $bookId)->first();
        $now = now();

        $libraryExists = $db->table('library')->where('book', $subBookId)->exists();
        $libraryData = [
            'title'         => "AI Citation Review: {$bookTitle}",
            'type'          => 'sub_book',
            'creator'       => $parent->creator ?? null,
            'creator_token' => $parent->creator_token ?? null,
            'visibility'    => $parent->visibility ?? 'public',
            'listed'        => false,
            'has_nodes'     => true,
            'timestamp'     => round(microtime(true) * 1000),
            'raw_json'      => json_encode(['type' => 'ai_review', 'parent' => $bookId]),
            'updated_at'    => $now,
        ];

        if ($libraryExists) {
            $db->table('library')->where('book', $subBookId)->update($libraryData);
        } else {
            $libraryData['book'] = $subBookId;
            $libraryData['created_at'] = $now;
            $db->table('library')->insert($libraryData);
        }

        // Save nodes to database (same logic as ProcessDocumentImportJob's saver):
        // stream-read the jsonl, one JSON object per line.
        $nodesData = [];
        foreach (file($nodesPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $decoded = json_decode(trim($line), true);
            if ($decoded !== null) {
                $nodesData[] = $decoded;
            }
        }
        $insertData = [];
        $now = now();
        $nodesPerChunk = 100;

        foreach ($nodesData as $index => $chunk) {
            $startLine = ($index + 1) * 100;
            $chunkId = floor($index / $nodesPerChunk) * 100;
            $nodeId = $this->helpers->generateNodeId($subBookId);
            $content = $this->helpers->ensureNodeIdInContent($chunk['content'] ?? '', $startLine, $nodeId);

            $rawJson = $chunk;
            $rawJson['startLine'] = $startLine;
            $rawJson['chunk_id'] = $chunkId;
            $rawJson['node_id'] = $nodeId;
            $rawJson['content'] = $content;

            $insertData[] = [
                'book'       => $subBookId,
                'startLine'  => $startLine,
                'chunk_id'   => $chunkId,
                'node_id'    => $nodeId,
                'content'    => $content,
                'footnotes'  => json_encode($chunk['footnotes'] ?? []),
                'plainText'  => $chunk['plainText'] ?? strip_tags($content),
                'type'       => $chunk['type'] ?? 'p',
                'raw_json'   => json_encode($rawJson),
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        // Bulk insert in 500-row batches
        foreach (array_chunk($insertData, 500) as $batch) {
            $db->table('nodes')->insert($batch);
        }

        // Write the renumbered nodes.json artifact (kept alongside nodes.jsonl —
        // the editor saver reads nodes.json)
        $renumbered = array_map(fn($r) => json_decode($r['raw_json'], true), $insertData);
        File::put("{$path}/nodes.json", json_encode($renumbered, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        Log::info("Imported AI review sub-book", [
            'subBookId' => $subBookId,
            'nodeCount' => count($insertData),
        ]);

        return $subBookId;
    }
}
