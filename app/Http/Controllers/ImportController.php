<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use App\Models\PgLibrary;
use App\Models\PgNodeChunk;
use App\Models\PgFootnote;
use App\Helpers\SubBookIdHelper;
use App\Http\Controllers\DbLibraryController;
use Illuminate\Support\Str;
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

        // Clean stale output files from any previous import to this book ID.
        // process_document.py caches footnotes.json — a leftover from a prior run
        // would cause it to skip footnote linking on the fresh HTML.
        foreach (['footnotes.json', 'nodes.json', 'audit.json', 'references.json', 'intermediate.html'] as $staleFile) {
            $staleFilePath = "{$path}/{$staleFile}";
            if (File::exists($staleFilePath)) {
                File::delete($staleFilePath);
            }
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

            // IMPORTANT: Create library record FIRST (before nodes)
            // RLS policy requires a matching library record to INSERT nodes
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
                    'volume' => $request->input('volume'),
                    'issue' => $request->input('issue'),
                    'booktitle' => $request->input('booktitle'),
                    'chapter' => $request->input('chapter'),
                    'editor' => $request->input('editor'),
                    'timestamp' => round(microtime(true) * 1000),
                    'visibility' => 'private',
                    'creator' => $creatorInfo['creator'],
                    'creator_token' => $creatorInfo['creator_token'],
                    'raw_json' => json_encode($request->all())
                ]
            );

            // Save node chunks to database AFTER library record exists
            // (RLS policy checks for matching library.creator/creator_token)
            if ($isDocxProcessing) {
                $this->saveNodeChunksToDatabase($path, $bookId);
                $this->saveFootnotesToDatabase($path, $bookId);
            }

            $totalProcessingTime = round((microtime(true) - $startTime) * 1000, 2);

            if ($request->expectsJson()) {
                $auditPath = "{$path}/audit.json";
                $auditData = File::exists($auditPath) ? json_decode(File::get($auditPath), true) : null;
                $hasIssues = $auditData && (
                    count($auditData['gaps'] ?? []) > 0 ||
                    count($auditData['unmatched_refs'] ?? []) > 0 ||
                    count($auditData['unmatched_defs'] ?? []) > 0
                );

                return response()->json([
                    'success' => true,
                    'bookId' => $bookId,
                    'library' => $createdRecord,
                    'processing_time_ms' => $totalProcessingTime,
                    'footnoteAudit' => $auditData,
                    'hasFootnoteIssues' => $hasIssues,
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
        try {
            $nodesPath = "{$path}/nodes.json";

            if (!File::exists($nodesPath)) {
                Log::warning('nodes.json not found for database save', ['book' => $bookId]);
                return;
            }

            $nodesData = json_decode(File::get($nodesPath), true);

            // Delete existing chunks
            PgNodeChunk::where('book', $bookId)->delete();

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

            // Update JSON file with renumbered values
            $renumberedJson = [];
            foreach ($insertData as $record) {
                $renumberedJson[] = json_decode($record['raw_json'], true);
            }
            File::put($nodesPath, json_encode($renumberedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        } catch (\Exception $e) {
            Log::error('Failed to save nodeChunks to database', [
                'book' => $bookId,
                'error' => substr($e->getMessage(), 0, 500),
                'chunks_attempted' => count($insertData ?? [])
            ]);
        }
    }

    /**
     * Save footnotes from JSON file to database with preview_nodes,
     * sub-book library records, and initial sub-book nodes.
     */
    private function saveFootnotesToDatabase(string $path, string $bookId): void
    {
        try {
            $footnotesPath = "{$path}/footnotes.json";
            if (!File::exists($footnotesPath)) {
                Log::info('No footnotes.json found — skipping footnote import', ['book' => $bookId]);
                return;
            }

            $footnotesData = json_decode(File::get($footnotesPath), true);
            if (empty($footnotesData)) return;

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

                // 1. Upsert footnote record with preview_nodes
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

                // 2. Upsert sub-book library record
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

                // 3. Upsert initial sub-book node
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

            // Write enriched footnotes back to JSON so frontend loadFromJSONFiles() includes preview_nodes
            File::put($footnotesPath, json_encode($enrichedForJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            Log::info("Saved {$upsertedCount} footnotes to database, wrote enriched footnotes.json", ['book' => $bookId]);

        } catch (\Exception $e) {
            Log::error('Failed to save footnotes to database', [
                'book'  => $bookId,
                'error' => substr($e->getMessage(), 0, 500),
            ]);
        }
    }
}
