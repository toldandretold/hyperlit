<?php

namespace App\Services;

use App\Models\PgNodeChunk;
use App\Models\PgFootnote;
use App\Models\PgLibrary;
use App\Helpers\SubBookIdHelper;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\PdfProcessor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class ContentFetchService
{
    private FileHelpers $fileHelpers;
    private HtmlProcessor $htmlProcessor;
    private PdfProcessor $pdfProcessor;

    public function __construct(FileHelpers $fileHelpers, HtmlProcessor $htmlProcessor, PdfProcessor $pdfProcessor)
    {
        $this->fileHelpers = $fileHelpers;
        $this->htmlProcessor = $htmlProcessor;
        $this->pdfProcessor = $pdfProcessor;
    }

    /**
     * Dry-run fetch: download HTML and save to disk, skip processing.
     *
     * @return array{status: string, reason: string, file_path: ?string, content_length: ?int, content_type: ?string}
     */
    public function dryFetch(object $libraryRecord): array
    {
        $bookId = $libraryRecord->book;
        $oaUrl = $libraryRecord->oa_url ?? null;
        $pdfUrl = $libraryRecord->pdf_url ?? null;

        $url = $oaUrl ?: $pdfUrl;
        if (!$url) {
            return [
                'status' => 'skipped',
                'reason' => 'No fetchable URL (no oa_url or pdf_url)',
                'file_path' => null,
                'content_length' => null,
                'content_type' => null,
            ];
        }

        $path = resource_path("markdown/{$bookId}");

        try {
            $response = Http::withHeaders([
                'User-Agent' => 'Hyperlit/1.0 (mailto:hello@hyperlit.app)',
            ])->timeout(30)->get($url);

            if (!$response->successful()) {
                return [
                    'status' => 'failed',
                    'reason' => "HTTP {$response->status()} fetching {$url}",
                    'file_path' => null,
                    'content_length' => null,
                    'content_type' => null,
                ];
            }

            $body = $response->body();
            $contentType = $response->header('Content-Type') ?? 'unknown';

            if (!File::exists($path)) {
                File::makeDirectory($path, 0755, true);
            }

            $htmlPath = "{$path}/original.html";
            File::put($htmlPath, $body);

            return [
                'status' => 'dry_run',
                'reason' => 'HTML saved (dry-run, processing skipped)',
                'file_path' => $htmlPath,
                'content_length' => strlen($body),
                'content_type' => $contentType,
            ];

        } catch (\Exception $e) {
            Log::error('ContentFetchService::dryFetch failed', [
                'book' => $bookId,
                'url' => $url,
                'error' => $e->getMessage(),
            ]);

            return [
                'status' => 'failed',
                'reason' => $e->getMessage(),
                'file_path' => null,
                'content_length' => null,
                'content_type' => null,
            ];
        }
    }

    /**
     * Fetch and import content for a library record.
     *
     * @return array{status: string, reason: string}
     */
    public function fetch(object $libraryRecord): array
    {
        $bookId = $libraryRecord->book;
        $oaUrl = $libraryRecord->oa_url ?? null;
        $pdfUrl = $libraryRecord->pdf_url ?? null;

        // Strategy 1: OA HTML
        if ($oaUrl) {
            return $this->fetchHtml($oaUrl, $bookId);
        }

        // Strategy 2: PDF (not yet implemented)
        if ($pdfUrl) {
            return [
                'status' => 'skipped',
                'reason' => 'PDF fetch not yet implemented',
            ];
        }

        return [
            'status' => 'skipped',
            'reason' => 'No fetchable URL (no oa_url or pdf_url)',
        ];
    }

    private function fetchHtml(string $url, string $bookId): array
    {
        $path = resource_path("markdown/{$bookId}");

        try {
            // 1. Fetch HTML
            $response = Http::withHeaders([
                'User-Agent' => 'Hyperlit/1.0 (mailto:hello@hyperlit.app)',
            ])->timeout(30)->get($url);

            if (!$response->successful()) {
                return [
                    'status' => 'failed',
                    'reason' => "HTTP {$response->status()} fetching {$url}",
                ];
            }

            $html = $response->body();
            if (strlen($html) < 100) {
                return [
                    'status' => 'failed',
                    'reason' => 'Fetched HTML too short (' . strlen($html) . ' bytes)',
                ];
            }

            // 2. Save HTML to resources/markdown/{bookId}/original.html
            if (!File::exists($path)) {
                File::makeDirectory($path, 0755, true);
            }

            $htmlPath = "{$path}/original.html";
            File::put($htmlPath, $html);

            // 3. Clean stale output files
            foreach (['nodes.json', 'footnotes.json', 'audit.json', 'references.json', 'intermediate.html'] as $staleFile) {
                $staleFilePath = "{$path}/{$staleFile}";
                if (File::exists($staleFilePath)) {
                    File::delete($staleFilePath);
                }
            }

            // 4. Process via HtmlProcessor
            $this->htmlProcessor->process($htmlPath, $path, $bookId);

            // 5. Wait for nodes.json
            $nodesPath = "{$path}/nodes.json";
            $attempts = 0;
            while (!File::exists($nodesPath) && $attempts < 15) {
                sleep(2);
                $attempts++;
            }

            if (!File::exists($nodesPath)) {
                return [
                    'status' => 'failed',
                    'reason' => 'Timed out waiting for nodes.json after HtmlProcessor',
                ];
            }

            // 6. Save nodes to DB
            $this->saveNodeChunksToDatabase($path, $bookId);

            // 7. Save footnotes to DB
            $this->saveFootnotesToDatabase($path, $bookId);

            // 8. Update library.has_nodes = true
            DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookId)
                ->update(['has_nodes' => true, 'updated_at' => now()]);

            return [
                'status' => 'imported',
                'reason' => 'HTML fetched and processed successfully',
            ];

        } catch (\Exception $e) {
            Log::error('ContentFetchService::fetchHtml failed', [
                'book' => $bookId,
                'url' => $url,
                'error' => $e->getMessage(),
            ]);

            return [
                'status' => 'failed',
                'reason' => $e->getMessage(),
            ];
        }
    }

    /**
     * Download a PDF and run it through the OCR → markdown → nodes pipeline.
     * Called explicitly by citation:ocr command (not by fetch()).
     *
     * @return array{status: string, reason: string, node_count?: int}
     */
    public function fetchPdf(string $pdfUrl, string $bookId): array
    {
        $path = resource_path("markdown/{$bookId}");

        try {
            // 1. Download PDF
            $response = Http::withHeaders([
                'User-Agent' => 'Hyperlit/1.0 (mailto:hello@hyperlit.app)',
            ])->timeout(60)->get($pdfUrl);

            if (!$response->successful()) {
                return [
                    'status' => 'failed',
                    'reason' => "HTTP {$response->status()} fetching {$pdfUrl}",
                ];
            }

            $body = $response->body();
            if (strlen($body) < 1000) {
                return [
                    'status' => 'failed',
                    'reason' => 'Fetched PDF too small (' . strlen($body) . ' bytes)',
                ];
            }

            // 2. Save PDF to resources/markdown/{bookId}/original.pdf
            if (!File::exists($path)) {
                File::makeDirectory($path, 0755, true);
            }

            $pdfPath = "{$path}/original.pdf";
            File::put($pdfPath, $body);

            // 3. Clean stale output files
            foreach (['nodes.json', 'footnotes.json', 'audit.json', 'references.json', 'intermediate.html', 'main-text.md'] as $staleFile) {
                $staleFilePath = "{$path}/{$staleFile}";
                if (File::exists($staleFilePath)) {
                    File::delete($staleFilePath);
                }
            }

            // 4. Process via PdfProcessor (OCR → markdown → nodes.json)
            $this->pdfProcessor->process($pdfPath, $path, $bookId);

            // 5. Wait for nodes.json (OCR is slower, allow up to 60s)
            $nodesPath = "{$path}/nodes.json";
            $attempts = 0;
            while (!File::exists($nodesPath) && $attempts < 30) {
                sleep(2);
                $attempts++;
            }

            if (!File::exists($nodesPath)) {
                return [
                    'status' => 'failed',
                    'reason' => 'Timed out waiting for nodes.json after PdfProcessor',
                ];
            }

            // 6. Save nodes to DB
            $this->saveNodeChunksToDatabase($path, $bookId);

            // 7. Save footnotes to DB
            $this->saveFootnotesToDatabase($path, $bookId);

            // 8. Update library.has_nodes = true
            DB::connection('pgsql_admin')->table('library')
                ->where('book', $bookId)
                ->update(['has_nodes' => true, 'updated_at' => now()]);

            // Count nodes for reporting
            $nodesData = json_decode(File::get($nodesPath), true);
            $nodeCount = is_array($nodesData) ? count($nodesData) : 0;

            return [
                'status' => 'imported',
                'reason' => 'PDF fetched, OCR processed, and imported successfully',
                'node_count' => $nodeCount,
            ];

        } catch (\Exception $e) {
            Log::error('ContentFetchService::fetchPdf failed', [
                'book' => $bookId,
                'url' => $pdfUrl,
                'error' => $e->getMessage(),
            ]);

            return [
                'status' => 'failed',
                'reason' => $e->getMessage(),
            ];
        }
    }

    /**
     * Save node chunks from JSON file to database.
     * Replicates ImportController::saveNodeChunksToDatabase logic.
     */
    private function saveNodeChunksToDatabase(string $path, string $bookId): void
    {
        $nodesPath = "{$path}/nodes.json";
        if (!File::exists($nodesPath)) {
            Log::warning('nodes.json not found for database save', ['book' => $bookId]);
            return;
        }

        $nodesData = json_decode(File::get($nodesPath), true);

        // Delete existing chunks
        PgNodeChunk::where('book', $bookId)->delete();

        $insertData = [];
        $now = now();
        $nodesPerChunk = 100;

        foreach ($nodesData as $index => $chunk) {
            $newStartLine = ($index + 1) * 100;
            $chunkIndex = floor($index / $nodesPerChunk);
            $newChunkId = $chunkIndex * 100;
            $nodeId = $this->fileHelpers->generateNodeId($bookId);
            $content = $this->fileHelpers->ensureNodeIdInContent($chunk['content'], $newStartLine, $nodeId);

            $rawJson = $chunk;
            $rawJson['startLine'] = $newStartLine;
            $rawJson['chunk_id'] = $newChunkId;
            $rawJson['node_id'] = $nodeId;
            $rawJson['content'] = $content;

            $insertData[] = [
                'book' => $bookId,
                'startLine' => $newStartLine,
                'chunk_id' => $newChunkId,
                'node_id' => $nodeId,
                'content' => $content,
                'footnotes' => json_encode($chunk['footnotes'] ?? []),
                'plainText' => $chunk['plainText'] ?? '',
                'type' => $chunk['type'] ?? 'p',
                'raw_json' => json_encode($rawJson),
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }

        $batchSize = 500;
        foreach (array_chunk($insertData, $batchSize) as $batch) {
            PgNodeChunk::insert($batch);
        }

        // Write renumbered JSON back
        $renumberedJson = array_map(fn($r) => json_decode($r['raw_json'], true), $insertData);
        File::put($nodesPath, json_encode($renumberedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        Log::info('ContentFetchService saved nodes to database', [
            'book' => $bookId,
            'count' => count($insertData),
        ]);
    }

    /**
     * Save footnotes from JSON file to database.
     * Replicates ImportController::saveFootnotesToDatabase logic.
     */
    private function saveFootnotesToDatabase(string $path, string $bookId): void
    {
        $footnotesPath = "{$path}/footnotes.json";
        if (!File::exists($footnotesPath)) {
            return;
        }

        $footnotesData = json_decode(File::get($footnotesPath), true);
        if (empty($footnotesData)) {
            return;
        }

        $library = PgLibrary::where('book', $bookId)->first();
        if (!$library) {
            Log::warning('Cannot save footnotes: parent library not found', ['book' => $bookId]);
            return;
        }

        $upsertedCount = 0;
        $enrichedForJson = [];

        foreach ($footnotesData as $footnote) {
            $footnoteId = $footnote['footnoteId'] ?? null;
            $content    = $footnote['content'] ?? '';
            if (!$footnoteId) continue;

            $subBookId = SubBookIdHelper::build($bookId, $footnoteId);
            $uuid      = (string) Str::uuid();
            $plainText = strip_tags($content);
            $nodeHtml  = '<p data-node-id="' . e($uuid) . '" no-delete-id="please" '
                       . 'style="min-height:1.5em;">' . e($plainText) . '</p>';

            $previewNodes = [[
                'book'        => $subBookId,
                'chunk_id'    => 0,
                'startLine'   => 1.0,
                'node_id'     => $uuid,
                'content'     => $nodeHtml,
                'footnotes'   => [],
                'hyperlights' => [],
                'hypercites'  => [],
            ]];

            $existing = PgFootnote::where('book', $bookId)
                ->where('footnoteId', $footnoteId)
                ->first();

            if ($existing) {
                PgFootnote::where('book', $bookId)
                    ->where('footnoteId', $footnoteId)
                    ->update([
                        'content'       => $content,
                        'sub_book_id'   => $subBookId,
                        'preview_nodes' => json_encode($previewNodes),
                    ]);
            } else {
                PgFootnote::create([
                    'book'          => $bookId,
                    'footnoteId'    => $footnoteId,
                    'content'       => $content,
                    'sub_book_id'   => $subBookId,
                    'preview_nodes' => $previewNodes,
                ]);
            }

            PgLibrary::updateOrInsert(
                ['book' => $subBookId],
                [
                    'creator'       => $library->creator,
                    'creator_token' => $library->creator_token,
                    'visibility'    => $library->visibility,
                    'listed'        => false,
                    'title'         => "Annotation: {$footnoteId}",
                    'type'          => 'sub_book',
                    'has_nodes'     => true,
                    'raw_json'      => json_encode([]),
                    'timestamp'     => round(microtime(true) * 1000),
                    'updated_at'    => now(),
                    'created_at'    => now(),
                ]
            );

            PgNodeChunk::updateOrCreate(
                ['book' => $subBookId, 'node_id' => $uuid],
                [
                    'chunk_id'   => 0,
                    'startLine'  => 1,
                    'content'    => $nodeHtml,
                    'plainText'  => $plainText,
                    'raw_json'   => json_encode([]),
                ]
            );

            $upsertedCount++;
            $enrichedForJson[] = [
                'footnoteId'    => $footnoteId,
                'content'       => $content,
                'preview_nodes' => $previewNodes,
            ];
        }

        File::put($footnotesPath, json_encode($enrichedForJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        Log::info("ContentFetchService saved {$upsertedCount} footnotes", ['book' => $bookId]);
    }
}
