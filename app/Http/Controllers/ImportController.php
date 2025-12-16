<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use App\Models\PgLibrary;
use App\Models\PgNodeChunk;
use App\Http\Controllers\DbLibraryController;
use App\Services\DocumentImport\ValidationService;
use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\Processors\MarkdownProcessor;
use App\Services\DocumentImport\Processors\HtmlProcessor;
use App\Services\DocumentImport\Processors\EpubProcessor;
use App\Services\DocumentImport\Processors\ZipProcessor;
use App\Services\DocumentImport\Processors\DocxProcessor;

class ImportController extends Controller
{
    public function __construct(
        private ValidationService $validator,
        private FileHelpers $helpers,
        private MarkdownProcessor $markdownProcessor,
        private HtmlProcessor $htmlProcessor,
        private EpubProcessor $epubProcessor,
        private ZipProcessor $zipProcessor,
        private DocxProcessor $docxProcessor
    ) {}

    public function createMainTextMarkdown(Request $request)
    {
        $bookId = $request->input('book');
        $title = $request->input('title');

        if (!$bookId || !$title) {
            return response()->json([
                'error' => 'citation_id and title are required.'
            ], 400);
        }

        $bookId = preg_replace('/[^a-zA-Z0-9_-]/', '', $bookId);

        if (empty($bookId)) {
            return response()->json(['error' => 'Invalid citation ID format.'], 400);
        }

        $path = resource_path("markdown/{$bookId}");

        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        $markdownContent = "# {$title}\n";
        File::put("{$path}/main-text.md", $markdownContent);

        Log::info('Basic markdown file created', [
            'book' => $bookId,
            'method' => 'createMainTextMarkdown'
        ]);

        return response()->json([
            'success' => true,
            'message' => "main-text.md created for citation_id {$bookId}",
            'path' => "{$path}/main-text.md"
        ]);
    }

    public function store(Request $request)
    {
        $startTime = microtime(true);
        Log::info('File upload started', [
            'book' => $request->input('book'),
            'has_file' => $request->hasFile('markdown_file'),
            'start_time' => $startTime,
        ]);

        // Validation
        $request->validate([
            'book' => 'required|string|regex:/^[a-zA-Z0-9_-]+$/',
            'title' => 'required|string|max:255',
            'author' => 'nullable|string|max:255',
            'year' => 'nullable|integer|min:1000|max:' . (date('Y') + 10),
            'markdown_file' => 'nullable|array',
            'markdown_file.*' => [
                'nullable',
                'file',
                function ($attribute, $value, $fail) {
                    if (!$value || !$value->isValid()) {
                        return;
                    }

                    $extension = strtolower($value->getClientOriginalExtension());
                    $allowedExtensions = ['md', 'doc', 'docx', 'epub', 'html', 'zip', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];

                    if (!in_array($extension, $allowedExtensions)) {
                        $fail('File must be .md, .doc, .docx, .epub, .html, .zip, or image file.');
                        return;
                    }

                    if ($value->getSize() > 50 * 1024 * 1024) {
                        $fail('File must be less than 50MB.');
                    }
                }
            ]
        ]);

        $bookId = preg_replace('/[^a-zA-Z0-9_-]/', '', $request->input('book'));

        if (empty($bookId)) {
            return redirect()->back()->with('error', 'Invalid citation ID format.');
        }

        $path = resource_path("markdown/{$bookId}");

        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        $isDocxProcessing = false;

        if ($request->hasFile('markdown_file')) {
            $files = $request->file('markdown_file');

            // Check if this is a folder upload (multiple files with .md + images)
            if (is_array($files) && count($files) > 1) {
                $hasMd = false;
                foreach ($files as $file) {
                    if (strtolower($file->getClientOriginalExtension()) === 'md') {
                        $hasMd = true;
                        break;
                    }
                }

                if ($hasMd) {
                    $this->zipProcessor->processFolderFiles($files, $path, $bookId);
                    $isDocxProcessing = true;
                } else {
                    $file = $files[0];
                    $extension = strtolower($file->getClientOriginalExtension());
                }
            } else {
                $file = is_array($files) ? $files[0] : $files;
                $extension = strtolower($file->getClientOriginalExtension());
            }

            // Process single file if not handled by folder upload
            if (!$isDocxProcessing && isset($file)) {
                // SECURITY: Validate file content before processing
                if (!$this->validator->validateUploadedFile($file)) {
                    Log::warning('File validation failed', [
                        'book' => $bookId,
                        'extension' => $extension,
                        'original_name' => $file->getClientOriginalName()
                    ]);

                    if ($request->expectsJson()) {
                        return response()->json([
                            'success' => false,
                            'error' => 'File validation failed. The file may contain suspicious content or invalid structure.'
                        ], 422);
                    }

                    return redirect()->back()->with('error', 'File validation failed. Please check the file format and content.');
                }

                $originalFilename = "original.{$extension}";
                $originalFilePath = "{$path}/{$originalFilename}";
                $file->move($path, $originalFilename);
                chmod($originalFilePath, 0644);

                Log::info('File upload completed', [
                    'book' => $bookId,
                    'extension' => $extension
                ]);

                $isDocxProcessing = $this->processFile($originalFilePath, $path, $bookId, $extension);
            }
        } else {
            $this->helpers->createBasicMarkdown($request, $path);
        }

        // Wait for processing to complete
        $finalPath = $isDocxProcessing ? "{$path}/nodes.json" : "{$path}/main-text.md";
        $fileDescription = $isDocxProcessing ? "nodes.json" : "main-text.md";

        $attempts = 0;
        while (!File::exists($finalPath) && $attempts < 15) {
            sleep(2);
            $attempts++;
        }

        if (File::exists($finalPath)) {
            $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);

            if (!$creatorInfo['valid']) {
                return response()->json([
                    'success' => false,
                    'message' => 'Invalid session'
                ], 401);
            }

            // Save node chunks to database if DOCX processing
            if ($isDocxProcessing) {
                $this->saveNodeChunksToDatabase($path, $bookId);
            }

            // Create/update library record
            $createdRecord = PgLibrary::updateOrCreate(
                ['book' => $bookId],
                [
                    'title' => $request->input('title'),
                    'author' => $request->input('author'),
                    'type' => $request->input('type') ?? 'book',
                    'year' => $request->input('year'),
                    'url' => $request->input('url'),
                    'pages' => $request->input('pages'),
                    'journal' => $request->input('journal'),
                    'publisher' => $request->input('publisher'),
                    'school' => $request->input('school'),
                    'note' => $request->input('note'),
                    'bibtex' => $request->input('bibtex'),
                    'timestamp' => round(microtime(true) * 1000),
                    'visibility' => 'private',
                    'creator' => $creatorInfo['creator'],
                    'creator_token' => $creatorInfo['creator_token'],
                    'raw_json' => json_encode($request->all())
                ]
            );

            $totalProcessingTime = round((microtime(true) - $startTime) * 1000, 2);
            Log::info('Complete processing finished successfully', [
                'book' => $bookId,
                'total_processing_duration_ms' => $totalProcessingTime
            ]);

            if ($request->expectsJson()) {
                return response()->json([
                    'success' => true,
                    'bookId' => $bookId,
                    'library' => $createdRecord,
                    'processing_time_ms' => $totalProcessingTime
                ]);
            }

            return redirect("/{$bookId}")->with('success', 'File processed successfully!');
        }

        // Failure case
        Log::error('File processing failed: Timed out waiting for output file.', [
            'book' => $bookId,
            'expected_path' => $finalPath
        ]);

        if ($request->expectsJson()) {
            return response()->json([
                'success' => false,
                'error' => 'Failed to process file. It may be too large or complex. Please try again.'
            ], 500);
        }

        return redirect()->back()->with('error', 'Failed to process file. Please try again.');
    }

    public function createNewMarkdown(Request $request)
    {
        $bookId = $request->input('book');
        $title = $request->input('title');

        if (!$bookId || !$title) {
            return response()->json([
                'error' => 'citation_id and title are required.'
            ], 400);
        }

        $bookId = preg_replace('/[^a-zA-Z0-9_-]/', '', $bookId);

        if (empty($bookId)) {
            return response()->json(['error' => 'Invalid citation ID format.'], 400);
        }

        $path = resource_path("markdown/{$bookId}");

        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        File::put("{$path}/main-text.md", "# {$title}\n");

        Log::info('New markdown file created', [
            'book' => $bookId,
            'method' => 'createNewMarkdown'
        ]);

        return response()->json([
            'success' => true,
            'message' => "main-text.md created for {$bookId}",
            'path' => "{$path}/main-text.md"
        ]);
    }

    /**
     * Process a file based on its extension
     *
     * @return bool Whether this triggers DOCX-style processing (waits for nodes.json)
     */
    private function processFile(string $filePath, string $outputPath, string $bookId, string $extension): bool
    {
        Log::info('Processing file', [
            'book' => $bookId,
            'extension' => $extension
        ]);

        switch ($extension) {
            case 'md':
                $this->markdownProcessor->process($filePath, $outputPath, $bookId);
                return true;

            case 'html':
            case 'htm':
                $this->htmlProcessor->process($filePath, $outputPath, $bookId);
                return true;

            case 'epub':
                $this->epubProcessor->process($filePath, $outputPath, $bookId);
                return true;

            case 'zip':
                $this->zipProcessor->process($filePath, $outputPath, $bookId);
                return true;

            case 'doc':
            case 'docx':
                $this->docxProcessor->process($filePath, $outputPath, $bookId);
                return true;

            default:
                Log::warning('Unsupported file extension', [
                    'book' => $bookId,
                    'extension' => $extension
                ]);
                return false;
        }
    }

    /**
     * Save node chunks from JSON file to database
     */
    private function saveNodeChunksToDatabase(string $path, string $bookId): void
    {
        $dbSaveStart = microtime(true);

        try {
            $nodesPath = "{$path}/nodes.json";

            if (!File::exists($nodesPath)) {
                Log::warning('nodes.json not found for database save', ['book' => $bookId]);
                return;
            }

            $nodesData = json_decode(File::get($nodesPath), true);

            // Delete existing chunks
            $deletedCount = PgNodeChunk::where('book', $bookId)->delete();
            Log::info('Existing chunks deleted', [
                'book' => $bookId,
                'deleted_count' => $deletedCount
            ]);

            // Prepare data for bulk insert with proper numbering
            $insertData = [];
            $now = now();
            $nodesPerChunk = 100;

            foreach ($nodesData as $index => $chunk) {
                $newStartLine = ($index + 1) * 100;
                $chunkIndex = floor($index / $nodesPerChunk);
                $newChunkId = $chunkIndex * 100;
                $nodeId = $this->helpers->generateNodeId($bookId);
                $content = $this->helpers->ensureNodeIdInContent($chunk['content'], $newStartLine, $nodeId);

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
                    'updated_at' => $now
                ];
            }

            // Bulk insert in batches
            $batchSize = 500;
            $batches = array_chunk($insertData, $batchSize);
            $totalInserted = 0;

            foreach ($batches as $batch) {
                PgNodeChunk::insert($batch);
                $totalInserted += count($batch);
            }

            Log::info('All nodeChunks saved to database', [
                'book' => $bookId,
                'chunks_saved' => $totalInserted,
                'total_batches' => count($batches),
                'db_save_duration_ms' => round((microtime(true) - $dbSaveStart) * 1000, 2)
            ]);

            // Update JSON file with renumbered values
            $renumberedJson = [];
            foreach ($insertData as $record) {
                $renumberedJson[] = json_decode($record['raw_json'], true);
            }
            File::put($nodesPath, json_encode($renumberedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

            Log::info('JSON file updated with renumbered values', [
                'book' => $bookId,
                'records_written' => count($renumberedJson)
            ]);

        } catch (\Exception $e) {
            Log::error('Failed to save nodeChunks to database', [
                'book' => $bookId,
                'error' => $e->getMessage()
            ]);
        }
    }
}
