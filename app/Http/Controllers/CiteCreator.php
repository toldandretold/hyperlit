<?php 

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Jobs\PandocConversionJob;
use App\Models\Citation;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;
use App\Models\PgLibrary;
use App\Models\PgNodeChunk;
use App\Http\Controllers\DbLibraryController;
use App\Services\CustomMarkdownConverter;

class CiteCreator extends Controller
{
    public function create()
    {
        return view('CiteCreator'); 
    }

    public function createMainTextMarkdown(Request $request) 
    {
        $citation_id = $request->input('citation_id');
        $title = $request->input('title');

        if (!$citation_id || !$title) {
            return response()->json([
                'error' => 'citation_id and title are required.'
            ], 400);
        }

        // Sanitize citation_id
        $citation_id = preg_replace('/[^a-zA-Z0-9_-]/', '', $citation_id);
        
        if (empty($citation_id)) {
            return response()->json(['error' => 'Invalid citation ID format.'], 400);
        }

        $path = resource_path("markdown/{$citation_id}");

        // Create the directory if it doesn't exist
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        // Prepare the markdown content
        $markdownContent = "# {$title}\n";

        // Write to main-text.md
        File::put("{$path}/main-text.md", $markdownContent);

        Log::info('Basic markdown file created', [
            'citation_id' => $citation_id,
            'method' => 'createMainTextMarkdown'
        ]);

        return response()->json([
            'success' => true,
            'message' => "main-text.md created for citation_id {$citation_id}",
            'path' => "{$path}/main-text.md"
        ]);
    }

    public function store(Request $request)
    {
        $startTime = microtime(true);
        Log::info('File upload started', [
            'citation_id' => $request->input('citation_id'),
            'has_file' => $request->hasFile('markdown_file'),
            'start_time' => $startTime,
        ]);

        $validationStart = microtime(true);
        
        // DEBUG: Log what we're actually receiving
        $files = null;
        if ($request->hasFile('markdown_file')) {
            $files = $request->file('markdown_file');
            Log::info('DEBUG: markdown_file detection', [
                'citation_id' => $request->input('citation_id'),
                'has_file' => true,
                'is_array' => is_array($files),
                'file_count' => is_array($files) ? count($files) : 1,
                'type' => gettype($files)
            ]);
        } elseif ($request->hasFile('markdown_file.0')) {
            // Check if files are sent as array with numeric indices
            $files = [];
            $i = 0;
            while ($request->hasFile("markdown_file.{$i}")) {
                $files[] = $request->file("markdown_file.{$i}");
                $i++;
            }
            Log::info('DEBUG: markdown_file array detection', [
                'citation_id' => $request->input('citation_id'),
                'method' => 'numeric_indices',
                'file_count' => count($files)
            ]);
        } else {
            // Try accessing as array directly
            $fileArray = $request->file('markdown_file') ?? [];
            if (is_array($fileArray) && !empty($fileArray)) {
                $files = $fileArray;
                Log::info('DEBUG: markdown_file direct array', [
                    'citation_id' => $request->input('citation_id'),
                    'method' => 'direct_array',
                    'file_count' => count($files)
                ]);
            } else {
                Log::info('DEBUG: No files detected', [
                    'citation_id' => $request->input('citation_id'),
                    'has_markdown_file' => $request->hasFile('markdown_file'),
                    'all_files' => array_keys($request->allFiles())
                ]);
            }
        }
        
        $request->validate([
            'citation_id' => 'required|string|regex:/^[a-zA-Z0-9_-]+$/',
            'title' => 'required|string|max:255',
            'author' => 'nullable|string|max:255',
            'year' => 'nullable|integer|min:1000|max:' . (date('Y') + 10),
            'markdown_file' => 'nullable|array',
            'markdown_file.*' => [
                'nullable',
                'file',
                function ($attribute, $value, $fail) {
                    if (!$value || !$value->isValid()) {
                        return; // Skip invalid uploads
                    }
                    
                    $extension = strtolower($value->getClientOriginalExtension());
                    
                    // Allow both single file extensions and image extensions
                    $allowedExtensions = ['md', 'doc', 'docx', 'epub', 'html', 'zip', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
                    
                    Log::info('Individual file validation', [
                        'file' => $value->getClientOriginalName(),
                        'extension' => $extension,
                        'size' => $value->getSize()
                    ]);
                    
                    if (!in_array($extension, $allowedExtensions)) {
                        $fail('File must be .md, .doc, .docx, .epub, .html, .zip, or image file (.jpg, .png, .gif, .svg, .webp).');
                        return;
                    }
                    
                    // Check file size (50MB max)
                    if ($value->getSize() > 50 * 1024 * 1024) {
                        $fail('File must be less than 50MB.');
                        return;
                    }
                }
            ]
        ]);
        
        Log::info('Validation completed', [
            'citation_id' => $request->input('citation_id'),
            'validation_duration_ms' => round((microtime(true) - $validationStart) * 1000, 2)
        ]);

        $citation_id = preg_replace('/[^a-zA-Z0-9_-]/', '', $request->input('citation_id'));

        if (empty($citation_id)) {
            return redirect()->back()->with('error', 'Invalid citation ID format.');
        }

        $path = resource_path("markdown/{$citation_id}");

        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        // --- MODIFIED: Flag to track which workflow is running ---
        $isDocxProcessing = false;

        if ($request->hasFile('markdown_file')) {
            $fileProcessStart = microtime(true);
            $files = $request->file('markdown_file');
            
            // Check if this is a true folder upload (multiple files with .md + images) or single file
            if (is_array($files) && count($files) > 1) {
                // Check if this looks like a folder upload (has .md files + other files)
                $hasMd = false;
                $hasImages = false;
                
                foreach ($files as $file) {
                    $ext = strtolower($file->getClientOriginalExtension());
                    if ($ext === 'md') $hasMd = true;
                    if (in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'])) $hasImages = true;
                }
                
                if ($hasMd) {
                    // This is a genuine folder upload with .md files
                    $this->processFolderFiles($files, $path, $citation_id);
                    $isDocxProcessing = true; // Set flag to wait for nodeChunks.json
                    
                    Log::info('Folder upload processing completed', [
                        'citation_id' => $citation_id,
                        'file_count' => count($files),
                        'processing_duration_ms' => round((microtime(true) - $fileProcessStart) * 1000, 2)
                    ]);
                } else {
                    // Multiple files but no .md files - treat as single file upload (take first)
                    $file = $files[0];
                    $extension = strtolower($file->getClientOriginalExtension());
                }
            } else {
                // Handle single file upload
                $file = is_array($files) ? $files[0] : $files;
                $extension = strtolower($file->getClientOriginalExtension());
            }
            
            // Process single file if not handled by folder upload above
            if (!$isDocxProcessing) {
                $originalFilename = "original.{$extension}";
                $originalFilePath = "{$path}/{$originalFilename}";

                // Store file size before moving the file
                $fileSize = $file->getSize();
                
                $file->move($path, $originalFilename);
                chmod($originalFilePath, 0644);

            Log::info('File upload completed', [
                'citation_id' => $citation_id,
                'extension' => $extension,
                'file_size_bytes' => $fileSize,
                'upload_duration_ms' => round((microtime(true) - $fileProcessStart) * 1000, 2)
            ]);

            $processingStart = microtime(true);
            if ($extension === 'md') {
                // --- MODIFIED: New workflow for MD files ---
                $isDocxProcessing = true; // Use same processing pipeline as DOCX
                
                Log::info('Starting markdown-to-JSON processing', [
                    'citation_id' => $citation_id,
                    'input_file' => $originalFilePath,
                    'processing_start_time' => $processingStart
                ]);
                
                // Process markdown file using the same pipeline as DOCX
                $this->processMarkdownFile($originalFilePath, $path, $citation_id);
                
                Log::info('Markdown processing completed', [
                    'citation_id' => $citation_id,
                    'processing_duration_ms' => round((microtime(true) - $processingStart) * 1000, 2)
                ]);
            } elseif ($extension === 'epub') {
                $isDocxProcessing = true; // Set the flag to wait for nodeChunks.json
                Log::info('Starting EPUB processing pipeline', [
                    'citation_id' => $citation_id,
                    'processing_start_time' => $processingStart
                ]);
                // This method now handles the full conversion from EPUB to nodeChunks.json
                $this->processEpubFile($originalFilePath, $path, $citation_id);
                Log::info('EPUB processing pipeline completed', [
                    'citation_id' => $citation_id,
                    'processing_duration_ms' => round((microtime(true) - $processingStart) * 1000, 2)
                ]);
            } elseif ($extension === 'html') {
                $isDocxProcessing = true; // Set the flag to wait for nodeChunks.json
                Log::info('Starting HTML processing pipeline', [
                    'citation_id' => $citation_id,
                    'processing_start_time' => $processingStart
                ]);
                // Process HTML file directly to JSON
                $this->processHtmlFile($originalFilePath, $path, $citation_id);
                Log::info('HTML processing pipeline completed', [
                    'citation_id' => $citation_id,
                    'processing_duration_ms' => round((microtime(true) - $processingStart) * 1000, 2)
                ]);
            } elseif (in_array($extension, ['doc', 'docx'])) {
                // --- MODIFIED: This is the new workflow for DOC/DOCX ---
                $isDocxProcessing = true; // Set the flag for the waiting logic

                Log::info('Dispatching PandocConversionJob for DOCX processing', [
                    'citation_id' => $citation_id,
                    'input_file' => $originalFilePath,
                    'job_dispatch_time' => $processingStart
                ]);

                // Dispatch the new job to handle the conversion in the background
                PandocConversionJob::dispatch($citation_id, $originalFilePath);
            } elseif ($extension === 'zip') {
                $isDocxProcessing = true; // Set flag to wait for nodeChunks.json
                Log::info('Starting ZIP folder processing pipeline', [
                    'citation_id' => $citation_id,
                    'processing_start_time' => $processingStart
                ]);
                // Process ZIP file containing MD + images
                $this->processFolderUpload($originalFilePath, $path, $citation_id);
                Log::info('ZIP folder processing pipeline completed', [
                    'citation_id' => $citation_id,
                    'processing_duration_ms' => round((microtime(true) - $processingStart) * 1000, 2)
                ]);
            }
        } // End single file processing
    } else {
            $basicMarkdownStart = microtime(true);
            Log::info('No file uploaded, creating basic markdown file', [
                'citation_id' => $citation_id,
                'start_time' => $basicMarkdownStart
            ]);
            $this->createBasicMarkdown($request, $path);
            Log::info('Basic markdown file created', [
                'citation_id' => $citation_id,
                'creation_duration_ms' => round((microtime(true) - $basicMarkdownStart) * 1000, 2)
            ]);
        }

        // --- MODIFIED: The waiting logic now handles both workflows ---
        $finalPath = '';
        $fileDescription = '';

        if ($isDocxProcessing) {
            // If we processed a DOCX, we wait for one of the final JSON files.
            $finalPath = "{$path}/nodeChunks.json";
            $fileDescription = "nodeChunks.json";
        } else {
            // For all other cases (MD, EPUB, or no file), we wait for main-text.md.
            $finalPath = "{$path}/main-text.md";
            $fileDescription = "main-text.md";
        }

        $waitingStart = microtime(true);
        $attempts = 0;
        Log::info("Starting wait for final file creation", [
            'citation_id' => $citation_id,
            'expected_file' => $fileDescription,
            'expected_path' => $finalPath,
            'wait_start_time' => $waitingStart
        ]);
        
        // Wait for the correct final file to be created by the background job.
        while (!File::exists($finalPath) && $attempts < 15) { // Increased attempts for longer jobs
            Log::debug("Waiting for {$fileDescription} creation", [
                'citation_id' => $citation_id,
                'attempt' => $attempts + 1,
                'elapsed_wait_time_ms' => round((microtime(true) - $waitingStart) * 1000, 2)
            ]);
            sleep(2);
            $attempts++;
        }
        
        $waitingDuration = round((microtime(true) - $waitingStart) * 1000, 2);
        Log::info("File waiting completed", [
            'citation_id' => $citation_id,
            'file_found' => File::exists($finalPath),
            'total_attempts' => $attempts,
            'waiting_duration_ms' => $waitingDuration
        ]);

        if (File::exists($finalPath)) {
            Log::info('File processing completed successfully', [
                'citation_id' => $citation_id,
                'final_file' => $fileDescription,
                'processing_time_approx' => ($attempts * 2) . ' seconds'
            ]);

            $creatorInfoStart = microtime(true);
            $creatorInfo = app(DbLibraryController::class)->getCreatorInfo($request);
            
            Log::info('Creator info retrieved', [
                'citation_id' => $citation_id,
                'creator_info_duration_ms' => round((microtime(true) - $creatorInfoStart) * 1000, 2),
                'valid' => $creatorInfo['valid']
            ]);

            if (!$creatorInfo['valid']) {
                return response()->json([
                    'success' => false,
                    'message' => 'Invalid session'
                ], 401);
            }

             if ($isDocxProcessing) {
        $dbSaveStart = microtime(true);
        try {
            // Load all the JSON files created by PandocConversionJob
            $nodeChunksPath = "{$path}/nodeChunks.json";
            $footnotesPath = "{$path}/footnotes.json";
            $referencesPath = "{$path}/references.json";
            
            Log::info('Starting database save process', [
                'citation_id' => $citation_id,
                'nodeChunks_exists' => File::exists($nodeChunksPath),
                'footnotes_exists' => File::exists($footnotesPath),
                'references_exists' => File::exists($referencesPath),
                'db_save_start_time' => $dbSaveStart
            ]);
            
            if (File::exists($nodeChunksPath)) {
                $jsonLoadStart = microtime(true);
                $nodeChunksData = json_decode(File::get($nodeChunksPath), true);
                $jsonLoadDuration = round((microtime(true) - $jsonLoadStart) * 1000, 2);
                
                Log::info('JSON file loaded, starting database saves', [
                    'citation_id' => $citation_id,
                    'chunks_count' => count($nodeChunksData),
                    'json_load_duration_ms' => $jsonLoadDuration
                ]);
                
                $chunkSaveStart = microtime(true);
                
                // First, delete existing chunks for this book to avoid duplicates
                $deleteStart = microtime(true);
                $deletedCount = PgNodeChunk::where('book', $citation_id)->delete();
                $deleteDuration = round((microtime(true) - $deleteStart) * 1000, 2);
                
                Log::info('Existing chunks deleted for bulk insert', [
                    'citation_id' => $citation_id,
                    'deleted_count' => $deletedCount,
                    'delete_duration_ms' => $deleteDuration
                ]);

                Log::info('CHECKPOINT 1: Right after delete, about to start renumbering', [
                    'citation_id' => $citation_id,
                    'nodeChunksData_count' => count($nodeChunksData),
                    'nodeChunksData_is_array' => is_array($nodeChunksData),
                    'file' => 'CiteCreator.php',
                    'line' => __LINE__
                ]);

                // Prepare data for bulk insert with proper numbering
                $bulkInsertStart = microtime(true);
                $insertData = [];
                $now = now();
                $nodesPerChunk = 100; // Group every 100 nodes into a chunk

                Log::info('CHECKPOINT 2: Variables initialized, starting renumbering', [
                    'citation_id' => $citation_id,
                    'total_nodes' => count($nodeChunksData),
                    'bulkInsertStart' => $bulkInsertStart,
                    'nodesPerChunk' => $nodesPerChunk,
                    'file' => 'CiteCreator.php',
                    'line' => __LINE__
                ]);

                foreach ($nodeChunksData as $index => $chunk) {
                    if ($index === 0) {
                        Log::info('CHECKPOINT 3: Inside foreach loop, first iteration', [
                            'citation_id' => $citation_id,
                            'index' => $index,
                            'chunk_keys' => array_keys($chunk),
                            'file' => 'CiteCreator.php',
                            'line' => __LINE__
                        ]);
                    }

                    // Calculate clean values with 100-unit gaps
                    $newStartLine = ($index + 1) * 100;  // 100, 200, 300...
                    $chunkIndex = floor($index / $nodesPerChunk);
                    $newChunkId = $chunkIndex * 100;      // 0, 100, 200...

                    // Generate unique node_id
                    $nodeId = $this->generateNodeId($citation_id);

                    // Add node_id to content if not present
                    $content = $this->ensureNodeIdInContent($chunk['content'], $newStartLine, $nodeId);

                    // Log first 3 nodes for debugging
                    if ($index < 3) {
                        Log::info('CHECKPOINT 4: Node renumbering details', [
                            'citation_id' => $citation_id,
                            'index' => $index,
                            'old_startLine' => $chunk['startLine'] ?? 'missing',
                            'new_startLine' => $newStartLine,
                            'old_chunk_id' => $chunk['chunk_id'] ?? 'missing',
                            'new_chunk_id' => $newChunkId,
                            'node_id' => $nodeId,
                            'content_preview' => substr($content, 0, 100),
                            'file' => 'CiteCreator.php',
                            'line' => __LINE__
                        ]);
                    }

                    // Update raw_json with new values
                    $rawJson = $chunk;
                    $rawJson['startLine'] = $newStartLine;
                    $rawJson['chunk_id'] = $newChunkId;
                    $rawJson['node_id'] = $nodeId;
                    $rawJson['content'] = $content;

                    $insertData[] = [
                        'book' => $citation_id,
                        'startLine' => $newStartLine,
                        'chunk_id' => $newChunkId,
                        'node_id' => $nodeId,
                        'content' => $content,
                        'footnotes' => json_encode($chunk['footnotes'] ?? []),
                        'hyperlights' => json_encode($chunk['hyperlights'] ?? []),
                        'hypercites' => json_encode($chunk['hypercites'] ?? []),
                        'plainText' => $chunk['plainText'] ?? '',
                        'type' => $chunk['type'] ?? 'p',
                        'raw_json' => json_encode($rawJson),
                        'created_at' => $now,
                        'updated_at' => $now
                    ];
                }

                Log::info('CHECKPOINT 5: Foreach loop completed, renumbering done', [
                    'citation_id' => $citation_id,
                    'nodes_processed' => count($insertData),
                    'startLine_range' => '100-' . (count($insertData) * 100),
                    'chunk_range' => '0-' . ((floor((count($insertData) - 1) / 100)) * 100),
                    'renumber_duration_ms' => round((microtime(true) - $bulkInsertStart) * 1000, 2),
                    'insertData_sample_keys' => !empty($insertData) ? array_keys($insertData[0]) : [],
                    'file' => 'CiteCreator.php',
                    'line' => __LINE__
                ]);

                // Bulk insert in batches of 500 to avoid memory issues
                $batchSize = 500;
                $totalInserted = 0;
                $batches = array_chunk($insertData, $batchSize);

                Log::info('CHECKPOINT 6: About to start batch insert', [
                    'citation_id' => $citation_id,
                    'total_batches' => count($batches),
                    'batch_size' => $batchSize,
                    'total_records_to_insert' => count($insertData),
                    'file' => 'CiteCreator.php',
                    'line' => __LINE__
                ]);

                foreach ($batches as $batchIndex => $batch) {
                    $batchStart = microtime(true);
                    PgNodeChunk::insert($batch);
                    $totalInserted += count($batch);

                    Log::info('CHECKPOINT 7: Batch inserted', [
                        'citation_id' => $citation_id,
                        'batch_number' => $batchIndex + 1,
                        'batch_size' => count($batch),
                        'batch_duration_ms' => round((microtime(true) - $batchStart) * 1000, 2),
                        'file' => 'CiteCreator.php',
                        'line' => __LINE__
                    ]);
                }
                
                $bulkInsertDuration = round((microtime(true) - $bulkInsertStart) * 1000, 2);
                $savedChunks = $totalInserted;
                
                Log::info('All nodeChunks saved to database', [
                    'citation_id' => $citation_id,
                    'chunks_saved' => $savedChunks,
                    'total_batches' => count($batches),
                    'bulk_insert_duration_ms' => $bulkInsertDuration,
                    'chunk_save_duration_ms' => round((microtime(true) - $chunkSaveStart) * 1000, 2)
                ]);

                // CRITICAL: Update the JSON file with renumbered values so frontend doesn't overwrite
                $jsonUpdateStart = microtime(true);
                $renumberedJson = [];
                foreach ($insertData as $record) {
                    $rawJson = json_decode($record['raw_json'], true);
                    $renumberedJson[] = $rawJson;
                }

                File::put($nodeChunksPath, json_encode($renumberedJson, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

                Log::info('CHECKPOINT 8: JSON file updated with renumbered values', [
                    'citation_id' => $citation_id,
                    'json_path' => $nodeChunksPath,
                    'records_written' => count($renumberedJson),
                    'json_update_duration_ms' => round((microtime(true) - $jsonUpdateStart) * 1000, 2),
                    'file' => 'CiteCreator.php',
                    'line' => __LINE__
                ]);
            }

            $totalDbDuration = round((microtime(true) - $dbSaveStart) * 1000, 2);
            Log::info('Database save process completed', [
                'citation_id' => $citation_id,
                'total_db_save_duration_ms' => $totalDbDuration
            ]);
            
            // Also save footnotes and references if you have models for them
            // This ensures complete data consistency between JSON files and database
            
        } catch (\Exception $e) {
            Log::error('Failed to save nodeChunks to database', [
                'citation_id' => $citation_id,
                'error' => $e->getMessage(),
                'db_save_duration_before_error_ms' => round((microtime(true) - $dbSaveStart) * 1000, 2)
            ]);
            // Don't fail the request, but log the error
        }
    }

            // ✅ Store the result of updateOrCreate in $createdRecord
            $libraryCreateStart = microtime(true);
            $createdRecord = PgLibrary::updateOrCreate(
                ['book' => $citation_id],
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

            if ($creatorInfo['creator'] && $createdRecord) {
                // This logic has been moved to DbLibraryController@bulkCreate
            }
            
            Log::info('PgLibrary record created/updated', [
                'citation_id' => $citation_id,
                'library_save_duration_ms' => round((microtime(true) - $libraryCreateStart) * 1000, 2),
                'record_id' => $createdRecord->id ?? 'unknown'
            ]);

            $totalProcessingTime = round((microtime(true) - $startTime) * 1000, 2);
            Log::info('Complete processing finished successfully', [
                'citation_id' => $citation_id,
                'total_processing_duration_ms' => $totalProcessingTime,
                'total_processing_duration_seconds' => round($totalProcessingTime / 1000, 2)
            ]);

            if ($request->expectsJson()) {
                // ✅ Now $createdRecord exists and can be returned
                return response()->json([
                    'success' => true,
                    'bookId' => $citation_id,
                    'library' => $createdRecord,
                    'processing_time_ms' => $totalProcessingTime
                ]);
            }

            return redirect("/{$citation_id}")->with('success', 'File processed successfully!');
        }

        // ❌ FAILURE CASE
        Log::error('File processing failed: Timed out waiting for output file.', [
            'citation_id' => $citation_id,
            'expected_path' => $finalPath
        ]);

        if ($request->expectsJson()) {
            return response()->json([
                'success' => false,
                'error' => 'Failed to process file. It may be too large or complex. Please try again.'
            ], 500);
        }

        return redirect()->back()->with('error', 'Failed to process file. It may be too large or complex. Please try again.');
        } // ✅ This closes the store() method

    private function runPythonScripts(string $path): void
    {
        // Validate the path is within expected bounds
        $realPath = realpath($path);
        $expectedBasePath = realpath(resource_path('markdown'));
        
        if (!$realPath || !str_starts_with($realPath, $expectedBasePath)) {
            throw new \InvalidArgumentException('Invalid path for Python script execution');
        }

        $epubPath = "{$path}/epub_original";
        
        // Ensure the epub_original directory exists and is within bounds
        if (!is_dir($epubPath) || !str_starts_with(realpath($epubPath), $expectedBasePath)) {
            throw new \InvalidArgumentException('Invalid EPUB path');
        }

        try {
            $processorScriptPath = base_path('app/Python/epub_processor.py');
            
            // Verify script file exists
            if (!file_exists($processorScriptPath)) {
                throw new \RuntimeException('Python script epub_processor.py not found');
            }

            Log::info('Python epub_processor.py execution started', [
                'epub_path' => basename($epubPath)
            ]);

            // Run epub_processor.py with timeout and proper error handling
            $process = new Process([
                'python3', 
                $processorScriptPath, 
                $epubPath
            ]);
            $process->setTimeout(300);
            $process->run();

            // Always log the output for debugging purposes
            $stdout = $process->getOutput();
            $stderr = $process->getErrorOutput();
            if (!empty($stdout) || !empty($stderr)) {
                Log::debug('Output from epub_processor.py', [
                    'stdout' => $stdout,
                    'stderr' => $stderr
                ]);
            }

            if (!$process->isSuccessful()) {
                Log::error('epub_processor.py script failed', [
                    'exit_code' => $process->getExitCode(),
                    'error_output' => $stderr // Already captured
                ]);
                throw new ProcessFailedException($process);
            }

            Log::info('Python epub_processor.py completed successfully');

        } catch (ProcessFailedException $e) {
            Log::error('Python script execution failed', [
                'error' => $e->getMessage(),
                'path' => basename($path)
            ]);
            throw $e;
        }
    }

    public function createNewMarkdown(Request $request)
    {
        $citation_id = $request->input('citation_id');
        $title = $request->input('title');

        if (!$citation_id || !$title) {
            return response()->json([
                'error' => 'citation_id and title are required.'
            ], 400);
        }

        // Sanitize citation_id
        $citation_id = preg_replace('/[^a-zA-Z0-9_-]/', '', $citation_id);
        
        if (empty($citation_id)) {
            return response()->json(['error' => 'Invalid citation ID format.'], 400);
        }

        $path = resource_path("markdown/{$citation_id}");

        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        File::put("{$path}/main-text.md", "# {$title}\n");

        Log::info('New markdown file created', [
            'citation_id' => $citation_id,
            'method' => 'createNewMarkdown'
        ]);

        return response()->json([
            'success' => true,
            'message' => "main-text.md created for {$citation_id}",
            'path' => "{$path}/main-text.md"
        ]);
    }

    private function validateUploadedFile($file): bool
    {
        // Check file size (50MB max)
        if ($file->getSize() > 50 * 1024 * 1024) {
            Log::debug('File validation failed: size too large', [
                'size' => $file->getSize(),
                'max_size' => 50 * 1024 * 1024
            ]);
            return false;
        }

        // Validate MIME type
        $allowedMimes = [
            'text/markdown',
            'text/plain',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/epub+zip',
            'text/html',
            'application/zip',
            'application/x-zip-compressed'
        ];

        if (!in_array($file->getMimeType(), $allowedMimes)) {
            Log::debug('File validation failed: invalid MIME type', [
                'mime_type' => $file->getMimeType(),
                'allowed_mimes' => $allowedMimes
            ]);
            return false;
        }

        // Additional content validation for specific file types
        $extension = strtolower($file->getClientOriginalExtension());
        
        switch ($extension) {
            case 'epub':
                return $this->validateEpubFile($file);
            case 'docx':
            case 'doc':
                return $this->validateDocFile($file);
            case 'md':
                return $this->validateMarkdownFile($file);
            case 'html':
                return $this->validateHtmlFile($file);
            case 'zip':
                return $this->validateZipFile($file);
        }

        return true;
    }

    private function validateEpubFile($file): bool
    {
        $zip = new \ZipArchive();
        $result = $zip->open($file->getPathname());
        
        if ($result !== TRUE) {
            Log::debug('EPUB validation failed: cannot open as ZIP', [
                'zip_error_code' => $result
            ]);
            return false;
        }

        $hasContainer = $zip->locateName('META-INF/container.xml') !== false;
        $hasMimetype = $zip->locateName('mimetype') !== false;
        
        $zip->close();
        
        if (!$hasContainer || !$hasMimetype) {
            Log::debug('EPUB validation failed: missing required files', [
                'has_container' => $hasContainer,
                'has_mimetype' => $hasMimetype
            ]);
        }
        
        return $hasContainer && $hasMimetype;
    }

    private function validateDocFile($file): bool
    {
        if (strtolower($file->getClientOriginalExtension()) === 'docx') {
            $zip = new \ZipArchive();
            $result = $zip->open($file->getPathname());
            
            if ($result !== TRUE) {
                Log::debug('DOCX validation failed: cannot open as ZIP');
                return false;
            }
            
            $hasWordDoc = $zip->locateName('word/document.xml') !== false;
            $zip->close();
            
            if (!$hasWordDoc) {
                Log::debug('DOCX validation failed: missing word/document.xml');
            }
            
            return $hasWordDoc;
        }
        
        return true; // For .doc files, basic MIME check is sufficient
    }

    private function validateMarkdownFile($file): bool
    {
        $handle = fopen($file->getPathname(), 'r');
        $content = fread($handle, 1024);
        fclose($handle);
        
        $suspiciousPatterns = [
            '/<script/i',
            '/javascript:/i',
            '/vbscript:/i',
            '/onload=/i',
            '/onerror=/i'
        ];
        
        foreach ($suspiciousPatterns as $pattern) {
            if (preg_match($pattern, $content)) {
                Log::warning('Markdown validation failed: suspicious content detected', [
                    'pattern_matched' => $pattern
                ]);
                return false;
            }
        }
        
        return true;
    }

    private function validateHtmlFile($file): bool
    {
        $handle = fopen($file->getPathname(), 'r');
        $content = fread($handle, 4096); // Read more for HTML files
        fclose($handle);
        
        // More comprehensive security patterns for HTML
        $suspiciousPatterns = [
            '/<script[^>]*>/i',
            '/javascript:/i',
            '/vbscript:/i',
            '/data:/i',
            '/on\w+\s*=/i', // Any on* event handlers (onclick, onload, etc.)
            '/<iframe/i',
            '/<object/i',
            '/<embed/i',
            '/<form/i',
            '/<input/i',
            '/<meta[^>]*http-equiv[^>]*refresh/i',
            '/expression\s*\(/i', // CSS expressions
            '/url\s*\(\s*["\']?javascript:/i',
            '/<link[^>]*href[^>]*javascript:/i',
            '/<style[^>]*>[^<]*javascript:/i'
        ];
        
        foreach ($suspiciousPatterns as $pattern) {
            if (preg_match($pattern, $content)) {
                Log::warning('HTML validation failed: suspicious content detected', [
                    'pattern_matched' => $pattern,
                    'file_name' => $file->getClientOriginalName()
                ]);
                return false;
            }
        }
        
        // Validate basic HTML structure
        if (!preg_match('/<html/i', $content) && !preg_match('/<body/i', $content) && !preg_match('/<div/i', $content)) {
            Log::debug('HTML validation: No recognizable HTML structure found');
            // Don't fail for this - could be HTML fragments
        }
        
        return true;
    }

    private function sanitizeHtmlFile(string $filePath): void
    {
        $originalContent = File::get($filePath);
        
        // Save content before sanitization for comparison
        $beforeLength = strlen($originalContent);
        
        // Remove potentially dangerous HTML tags and attributes
        $content = strip_tags($originalContent, '<html><head><body><div><span><p><h1><h2><h3><h4><h5><h6><br><strong><b><em><i><ul><ol><li><a><img><blockquote><code><pre><table><tr><td><th><thead><tbody><hr><sup><sub>');
        
        // Remove javascript: and data: URLs
        $content = preg_replace('/(?:javascript|data|vbscript):[^"\'\\s>]*/i', '', $content);
        
        // Remove all event handlers (onclick, onload, etc.)
        $content = preg_replace('/\son\w+\s*=\s*["\'][^"\']*["\']/i', '', $content);
        
        // Remove style attributes that might contain expressions
        $content = preg_replace('/\sstyle\s*=\s*["\'][^"\']*expression[^"\']*["\']/i', '', $content);
        
        // Log what sanitization removed
        $afterLength = strlen($content);
        
        Log::info('HTML sanitization results', [
            'file_path' => basename($filePath),
            'before_length' => $beforeLength,
            'after_length' => $afterLength,
            'removed_chars' => $beforeLength - $afterLength,
            'content_changed' => $originalContent !== $content
        ]);
        
        if ($originalContent !== $content) {
            // Save sanitized version for comparison
            $debugSanitizedPath = dirname($filePath) . '/debug_sanitized.html';
            File::put($debugSanitizedPath, $content);
            Log::warning('HTML sanitization changed content, saved debug copy to: ' . $debugSanitizedPath);
        }
        
        File::put($filePath, $content);
    }

    private function processHtmlFile(string $htmlFilePath, string $outputPath, string $citation_id): void
    {
        $processStart = microtime(true);
        $pythonScriptPath = base_path('app/Python/process_document.py');

        Log::info('processHtmlFile started', [
            'citation_id' => $citation_id,
            'input_file' => basename($htmlFilePath),
            'process_start_time' => $processStart
        ]);

        try {
            // Step 1: Save original HTML for comparison
            $debugStart = microtime(true);
            $originalHtmlContent = File::get($htmlFilePath);
            $debugHtmlPath = "{$outputPath}/debug_original.html";
            File::put($debugHtmlPath, $originalHtmlContent);
            
            Log::info('Debug files created', [
                'citation_id' => $citation_id,
                'debug_duration_ms' => round((microtime(true) - $debugStart) * 1000, 2)
            ]);
            
            Log::info("Original HTML saved for debugging:", [
                'debug_file' => $debugHtmlPath,
                'html_preview' => substr($originalHtmlContent, 0, 1000),
                'full_length' => strlen($originalHtmlContent),
                'contains_script_tags' => substr_count(strtolower($originalHtmlContent), '<script'),
                'contains_footnotes' => preg_match_all('/\[(?:\^|\d+)\]/', $originalHtmlContent, $matches)
            ]);
            
            // Step 2: Sanitize the HTML file
            $sanitizeStart = microtime(true);
            $this->sanitizeHtmlFile($htmlFilePath);
            Log::info('HTML sanitization completed', [
                'citation_id' => $citation_id,
                'sanitize_duration_ms' => round((microtime(true) - $sanitizeStart) * 1000, 2)
            ]);
            
            // Step 3: Preprocess HTML - normalize IDs and extract footnotes
            $preprocessStart = microtime(true);
            $preprocessorPath = base_path('app/Python/preprocess_html.py');
            $preprocessedHtmlPath = "{$outputPath}/preprocessed.html";
            
            Log::info("Running HTML preprocessor...", [
                'citation_id' => $citation_id,
                'preprocessor' => basename($preprocessorPath),
                'input' => basename($htmlFilePath),
                'output' => basename($preprocessedHtmlPath)
            ]);
            
            $preprocessProcess = new Process([
                'python3',
                $preprocessorPath,
                $htmlFilePath,
                $preprocessedHtmlPath
            ]);
            $preprocessProcess->setTimeout(300);
            $preprocessProcess->run();
            
            $preprocessDuration = round((microtime(true) - $preprocessStart) * 1000, 2);
            
            if (!$preprocessProcess->isSuccessful()) {
                Log::error("HTML preprocessing failed", [
                    'citation_id' => $citation_id,
                    'preprocess_duration_ms' => $preprocessDuration,
                    'stdout' => $preprocessProcess->getOutput(),
                    'stderr' => $preprocessProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($preprocessProcess);
            }
            
            Log::info("HTML preprocessing completed", [
                'citation_id' => $citation_id,
                'preprocess_duration_ms' => $preprocessDuration,
                'stdout' => $preprocessProcess->getOutput()
            ]);
            
            // Step 4: Run the dedicated HTML footnote processor
            $pythonScriptStart = microtime(true);
            $htmlProcessorPath = base_path('app/Python/html_footnote_processor.py');
            
            Log::info("Running dedicated HTML footnote processor...", [
                'citation_id' => $citation_id,
                'script' => basename($htmlProcessorPath),
                'html_input' => basename($preprocessedHtmlPath),
                'output_dir' => basename($outputPath),
                'book_id' => $citation_id,
                'python_start_time' => $pythonScriptStart
            ]);

            $pythonProcess = new Process([
                'python3',
                $htmlProcessorPath,
                $preprocessedHtmlPath,
                $outputPath,
                $citation_id // Pass citation_id as book_id
            ]);
            $pythonProcess->setTimeout(300);
            $pythonProcess->run();
            
            $pythonScriptDuration = round((microtime(true) - $pythonScriptStart) * 1000, 2);

            if (!$pythonProcess->isSuccessful()) {
                Log::error("Python script execution failed", [
                    'citation_id' => $citation_id,
                    'python_duration_ms' => $pythonScriptDuration,
                    'stdout' => $pythonProcess->getOutput(),
                    'stderr' => $pythonProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($pythonProcess);
            }
            Log::info("Python script executed successfully", [
                'citation_id' => $citation_id,
                'python_duration_ms' => $pythonScriptDuration
            ]);

        } catch (ProcessFailedException $exception) {
            $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
            Log::error("HTML processing failed for {$citation_id}", [
                'error' => $exception->getMessage(),
                'total_process_duration_ms' => $totalProcessDuration,
                'stdout' => $exception->getProcess()->getOutput(),
                'stderr' => $exception->getProcess()->getErrorOutput(),
            ]);
            throw $exception;
        } finally {
            // Clean up intermediate files
            $preprocessedHtmlPath = "{$outputPath}/preprocessed.html";
            if (File::exists($preprocessedHtmlPath)) {
                File::delete($preprocessedHtmlPath);
            }
            
            $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
            Log::info("processHtmlFile completed", [
                'citation_id' => $citation_id,
                'total_process_duration_ms' => $totalProcessDuration
            ]);
        }
    }

    private function sanitizeMarkdownFile(string $filePath): void
    {
        $originalContent = File::get($filePath);
        
        // Save content before sanitization for comparison
        $beforeLength = strlen($originalContent);
        $beforeFootnotes = preg_match_all('/^10[2-5]\s/', $originalContent, $matches);
        
        // Remove potentially dangerous HTML tags and attributes
        $content = strip_tags($originalContent, '<h1><h2><h3><h4><h5><h6><p><br><strong><em><ul><ol><li><a><img><blockquote><code><pre>');
        
        // Remove javascript: and data: URLs
        $content = preg_replace('/(?:javascript|data|vbscript):[^"\'\s>]*/i', '', $content);
        
        // Log what sanitization removed
        $afterLength = strlen($content);
        $afterFootnotes = preg_match_all('/^10[2-5]\s/', $content, $matches);
        
        Log::warning('Markdown sanitization results', [
            'file_path' => basename($filePath),
            'before_length' => $beforeLength,
            'after_length' => $afterLength,
            'removed_chars' => $beforeLength - $afterLength,
            'footnotes_before' => $beforeFootnotes,
            'footnotes_after' => $afterFootnotes,
            'content_changed' => $originalContent !== $content
        ]);
        
        if ($originalContent !== $content) {
            // Save sanitized version for comparison
            $debugSanitizedPath = dirname($filePath) . '/debug_sanitized.md';
            File::put($debugSanitizedPath, $content);
            Log::warning('Sanitization changed content, saved debug copy to: ' . $debugSanitizedPath);
        }
        
        File::put($filePath, $content);
    }

    private function processEpubFile(string $originalFilePath, string $path, string $citation_id): void
    {
        $epubPath = "{$path}/epub_original";
        
        if (!File::exists($epubPath)) {
            File::makeDirectory($epubPath, 0755, true);
        }

        $zip = new \ZipArchive();
        if ($zip->open($originalFilePath) === TRUE) {
            $numFiles = $zip->numFiles; // Get file count before closing
            $skippedFiles = 0;

            // Pre-extraction validation
            for ($i = 0; $i < $numFiles; $i++) {
                $stat = $zip->statIndex($i);
                if (!$stat) continue;

                if ($stat['size'] > 10 * 1024 * 1024) { // 10MB per file
                    Log::warning('Skipping large file in EPUB', ['filename' => $stat['name'], 'size' => $stat['size']]);
                    $skippedFiles++;
                    continue;
                }
                if (strpos($stat['name'], '..') !== false || strpos($stat['name'], '/') === 0) {
                    Log::warning('Skipping suspicious file path in EPUB', ['filename' => $stat['name']]);
                    $skippedFiles++;
                    continue;
                }
            }
            
            $zip->extractTo($epubPath);
            $zip->close();
            
            $this->setSecurePermissions($epubPath);
            
            Log::info('EPUB extraction completed', [
                'total_files' => $numFiles, // Use stored file count
                'skipped_files' => $skippedFiles,
                'extracted_to' => basename($epubPath)
            ]);
            
            // Step 1: Run epub_processor.py to convert EPUB to a single HTML file
            $this->runPythonScripts($path);

            // Step 2: Process the generated HTML to create node chunks, footnotes, etc.
            $htmlPath = "{$path}/main-text.html";
            if (File::exists($htmlPath)) {
                $documentProcessorScript = base_path('app/Python/process_document.py');
                
                Log::info("Running document processor on EPUB-generated HTML", [
                    'citation_id' => $citation_id,
                    'script' => basename($documentProcessorScript),
                    'html_input' => basename($htmlPath)
                ]);

                $process = new Process([
                    'python3',
                    $documentProcessorScript,
                    $htmlPath,
                    $path, // output directory
                    $citation_id
                ]);
                $process->setTimeout(300);
                $process->run();

                if (!$process->isSuccessful()) {
                    Log::error("Python script process_document.py failed for EPUB", [
                        'citation_id' => $citation_id,
                        'stdout' => $process->getOutput(),
                        'stderr' => $process->getErrorOutput()
                    ]);
                    throw new ProcessFailedException($process);
                }
                Log::info("Python script process_document.py executed successfully for EPUB", ['citation_id' => $citation_id]);

                // Clean up the intermediate html file
                // File::delete($htmlPath);

            } else {
                Log::error('main-text.html not found after EPUB processing.', [
                    'citation_id' => $citation_id,
                    'expected_path' => $htmlPath
                ]);
                throw new \RuntimeException("main-text.html not found after EPUB processing.");
            }

        } else {
            Log::error('Failed to open EPUB file', [
                'file_path' => basename($originalFilePath)
            ]);
            throw new \RuntimeException("Failed to extract EPUB file");
        }
    }

    private function processFolderUpload(string $originalFilePath, string $path, string $citation_id): void
    {
        $processStart = microtime(true);
        $extractPath = "{$path}/folder_extracted";
        
        Log::info('processFolderUpload started', [
            'citation_id' => $citation_id,
            'zip_file' => basename($originalFilePath),
            'process_start_time' => $processStart
        ]);
        
        // Create extraction directory
        if (!File::exists($extractPath)) {
            File::makeDirectory($extractPath, 0755, true);
        }
        
        try {
            // Extract ZIP file
            $zip = new \ZipArchive();
            if ($zip->open($originalFilePath) === TRUE) {
                $numFiles = $zip->numFiles;
                $skippedFiles = 0;
                $markdownFile = null;
                $imageFiles = [];
                
                // Pre-validation: scan for MD file and images
                for ($i = 0; $i < $numFiles; $i++) {
                    $stat = $zip->statIndex($i);
                    if (!$stat) continue;
                    
                    $filename = $stat['name'];
                    $filesize = $stat['size'];
                    
                    // Security checks
                    if ($filesize > 50 * 1024 * 1024) { // 50MB per file
                        Log::warning('Skipping large file in ZIP', ['filename' => $filename, 'size' => $filesize]);
                        $skippedFiles++;
                        continue;
                    }
                    
                    if (strpos($filename, '..') !== false || strpos($filename, '/') === 0) {
                        Log::warning('Skipping suspicious file path in ZIP', ['filename' => $filename]);
                        $skippedFiles++;
                        continue;
                    }
                    
                    // Check file types
                    $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
                    if ($extension === 'md') {
                        if ($markdownFile === null) {
                            $markdownFile = $filename;
                        } else {
                            Log::warning('Multiple MD files found, using first: ' . $markdownFile);
                        }
                    } elseif (in_array($extension, ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'])) {
                        $imageFiles[] = $filename;
                    }
                }
                
                // Validate we have required files
                if (!$markdownFile) {
                    throw new \RuntimeException("No markdown (.md) file found in ZIP");
                }
                
                Log::info('ZIP file analysis completed', [
                    'citation_id' => $citation_id,
                    'markdown_file' => $markdownFile,
                    'image_count' => count($imageFiles),
                    'skipped_files' => $skippedFiles
                ]);
                
                // Extract all files
                $zip->extractTo($extractPath);
                $zip->close();
                
                // Set secure permissions
                $this->setSecurePermissions($extractPath);
                
                // Create media directory in final location
                $mediaDir = "{$path}/media";
                if (!File::exists($mediaDir)) {
                    File::makeDirectory($mediaDir, 0755, true);
                }
                
                // Process images with security validation
                foreach ($imageFiles as $imageFile) {
                    $sourcePath = "{$extractPath}/{$imageFile}";
                    $targetPath = "{$mediaDir}/" . basename($imageFile);
                    
                    if (File::exists($sourcePath)) {
                        // Validate image file
                        if ($this->validateImageFile($sourcePath)) {
                            File::copy($sourcePath, $targetPath);
                            chmod($targetPath, 0644);
                            Log::debug('Image copied', ['from' => $imageFile, 'to' => basename($targetPath)]);
                        } else {
                            Log::warning('Image validation failed, skipping', ['file' => $imageFile]);
                        }
                    }
                }
                
                // Process the markdown file
                $markdownPath = "{$extractPath}/{$markdownFile}";
                if (File::exists($markdownPath)) {
                    // Update image references in markdown to point to media/ directory
                    $this->updateMarkdownImagePaths($markdownPath, $imageFiles, $citation_id);
                    
                    // Process markdown using existing pipeline
                    $this->processMarkdownFile($markdownPath, $path, $citation_id);
                } else {
                    throw new \RuntimeException("Markdown file not found after extraction: {$markdownFile}");
                }
                
                // Clean up extraction directory
                $this->recursiveDelete($extractPath);
                
            } else {
                throw new \RuntimeException("Failed to open ZIP file");
            }
            
        } catch (\Exception $e) {
            Log::error("Folder upload processing failed", [
                'citation_id' => $citation_id,
                'error' => $e->getMessage(),
                'process_duration_ms' => round((microtime(true) - $processStart) * 1000, 2)
            ]);
            
            // Clean up on failure
            if (File::exists($extractPath)) {
                $this->recursiveDelete($extractPath);
            }
            
            throw $e;
        }
        
        Log::info('processFolderUpload completed successfully', [
            'citation_id' => $citation_id,
            'total_duration_ms' => round((microtime(true) - $processStart) * 1000, 2)
        ]);
    }

    private function setSecurePermissions(string $directory): void
    {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($directory)
        );
        
        $fileCount = 0;
        $dirCount = 0;
        
        foreach ($iterator as $file) {
            if ($file->isFile()) {
                chmod($file->getPathname(), 0644);
                $fileCount++;
            } elseif ($file->isDir()) {
                chmod($file->getPathname(), 0755);
                $dirCount++;
            }
        }
        
        Log::debug('File permissions set', [
            'directory' => basename($directory),
            'files_processed' => $fileCount,
            'directories_processed' => $dirCount
        ]);
    }

    private function createBasicMarkdown(Request $request, string $path): void
    {
        $title = $request->input('title') ?? 'Untitled';
        $markdownContent = "# {$title}\n\n";
        $markdownContent .= "**Author:** " . ($request->input('author') ?? 'Unknown') . "\n";
        $markdownContent .= "**Year:** " . ($request->input('year') ?? 'Unknown') . "\n";
        
        File::put("{$path}/main-text.md", $markdownContent);
        
        Log::debug('Basic markdown file created', [
            'title' => $title,
            'path' => basename($path)
        ]);
    }

    private function processMarkdownFile(string $markdownFilePath, string $outputPath, string $citation_id): void
    {
        $processStart = microtime(true);
        $htmlOutputPath = "{$outputPath}/intermediate.html";
        $pythonScriptPath = base_path('app/Python/process_document.py');

        Log::info('processMarkdownFile started', [
            'citation_id' => $citation_id,
            'input_file' => basename($markdownFilePath),
            'process_start_time' => $processStart
        ]);

        try {
            // Step 1: Save original markdown for comparison
            $debugStart = microtime(true);
            $originalMarkdownContent = File::get($markdownFilePath);
            $debugMarkdownPath = "{$outputPath}/debug_original.md";
            File::put($debugMarkdownPath, $originalMarkdownContent);
            
            Log::info('Debug files created', [
                'citation_id' => $citation_id,
                'debug_duration_ms' => round((microtime(true) - $debugStart) * 1000, 2)
            ]);
            
            Log::info("Original markdown saved for debugging:", [
                'debug_file' => $debugMarkdownPath,
                'markdown_preview' => substr($originalMarkdownContent, 0, 1000),
                'full_length' => strlen($originalMarkdownContent),
                'footnote_count_102_105' => preg_match_all('/^10[2-5]\s/', $originalMarkdownContent, $matches),
                'contains_notes_headers' => substr_count(strtolower($originalMarkdownContent), '## notes'),
                'contains_separators' => substr_count($originalMarkdownContent, '---')
            ]);
            
            // Step 2: Sanitize the markdown file
            $sanitizeStart = microtime(true);
            $this->sanitizeMarkdownFile($markdownFilePath);
            Log::info('Markdown sanitization completed', [
                'citation_id' => $citation_id,
                'sanitize_duration_ms' => round((microtime(true) - $sanitizeStart) * 1000, 2)
            ]);
            
            // Step 2.5: Fix image references BEFORE markdown-to-HTML conversion
            $preConversionStart = microtime(true);
            $this->fixImageReferencesInMarkdown($markdownFilePath, $citation_id);
            Log::info('Pre-conversion image fix completed', [
                'citation_id' => $citation_id,
                'pre_conversion_duration_ms' => round((microtime(true) - $preConversionStart) * 1000, 2)
            ]);
            
            Log::info('Step 1: Converting Markdown to HTML...', [
                'citation_id' => $citation_id,
                'input' => basename($markdownFilePath),
                'output' => basename($htmlOutputPath)
            ]);

            // Step 2: Convert Markdown to HTML using Python markdown (preserves multiple footnote sections)
            $mdToHtmlStart = microtime(true);
            $markdownConverterPath = base_path('app/Python/simple_md_to_html.py');
            $markdownProcess = new Process([
                'python3',
                $markdownConverterPath,
                $markdownFilePath,
                $htmlOutputPath
            ]);
            $markdownProcess->setTimeout(300); // 5 minutes timeout
            $markdownProcess->run();
            
            $mdToHtmlDuration = round((microtime(true) - $mdToHtmlStart) * 1000, 2);

            if (!$markdownProcess->isSuccessful()) {
                Log::error("Markdown conversion failed", [
                    'citation_id' => $citation_id,
                    'conversion_duration_ms' => $mdToHtmlDuration,
                    'stdout' => $markdownProcess->getOutput(),
                    'stderr' => $markdownProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($markdownProcess);
            }
            Log::info("Markdown to HTML conversion successful", [
                'citation_id' => $citation_id,
                'conversion_duration_ms' => $mdToHtmlDuration
            ]);
            
            // Save and log the HTML content for debugging footnote sections
            if (File::exists($htmlOutputPath)) {
                $htmlContent = File::get($htmlOutputPath);
                
                // Save a copy of the HTML for inspection
                $debugHtmlPath = "{$outputPath}/debug_converted.html";
                File::put($debugHtmlPath, $htmlContent);
                
                Log::info("HTML Content Generated and saved for debugging:", [
                    'citation_id' => $citation_id,
                    'debug_file_saved' => $debugHtmlPath,
                    'html_preview' => substr($htmlContent, 0, 2000),
                    'full_length' => strlen($htmlContent),
                    'contains_hr' => strpos($htmlContent, '<hr') !== false ? 'YES' : 'NO',
                    'contains_notes_headers' => preg_match('/<h[1-6][^>]*>.*notes.*<\/h[1-6]>/i', $htmlContent) ? 'YES' : 'NO',
                    'footnote_patterns' => substr_count($htmlContent, '[^') + substr_count($htmlContent, '[1]') + substr_count($htmlContent, '[2]')
                ]);
            }

            // Step 3: Run the Python script on the generated HTML
            $pythonScriptStart = microtime(true);
            Log::info("Step 2: Running Python script...", [
                'citation_id' => $citation_id,
                'script' => basename($pythonScriptPath),
                'html_input' => basename($htmlOutputPath),
                'output_dir' => basename($outputPath),
                'book_id' => $citation_id,
                'python_start_time' => $pythonScriptStart
            ]);

            $pythonProcess = new Process([
                'python3',
                $pythonScriptPath,
                $htmlOutputPath,
                $outputPath,
                $citation_id // Pass citation_id as book_id
            ]);
            $pythonProcess->setTimeout(300);
            $pythonProcess->run();
            
            $pythonScriptDuration = round((microtime(true) - $pythonScriptStart) * 1000, 2);

            if (!$pythonProcess->isSuccessful()) {
                Log::error("Python script execution failed", [
                    'citation_id' => $citation_id,
                    'python_duration_ms' => $pythonScriptDuration,
                    'stdout' => $pythonProcess->getOutput(),
                    'stderr' => $pythonProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($pythonProcess);
            }
            Log::info("Python script executed successfully", [
                'citation_id' => $citation_id,
                'python_duration_ms' => $pythonScriptDuration
            ]);

        } catch (ProcessFailedException $exception) {
            $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
            Log::error("Markdown processing failed for {$citation_id}", [
                'error' => $exception->getMessage(),
                'total_process_duration_ms' => $totalProcessDuration,
                'stdout' => $exception->getProcess()->getOutput(),
                'stderr' => $exception->getProcess()->getErrorOutput(),
            ]);
            throw $exception;
        } finally {
            // Step 4: Clean up the intermediate HTML file
            $cleanupStart = microtime(true);
            if (File::exists($htmlOutputPath)) {
                File::delete($htmlOutputPath);
            }
            $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
            Log::info("processMarkdownFile completed", [
                'citation_id' => $citation_id,
                'cleanup_duration_ms' => round((microtime(true) - $cleanupStart) * 1000, 2),
                'total_process_duration_ms' => $totalProcessDuration
            ]);
        }
    }

    private function processFolderFiles(array $files, string $path, string $citation_id): void
    {
        $processStart = microtime(true);
        $markdownFiles = [];
        $imageFiles = [];
        
        Log::info('processFolderFiles started', [
            'citation_id' => $citation_id,
            'file_count' => count($files),
            'process_start_time' => $processStart
        ]);
        
        // Create media directory
        $mediaDir = "{$path}/media";
        if (!File::exists($mediaDir)) {
            File::makeDirectory($mediaDir, 0755, true);
        }
        
        // Separate markdown and image files
        foreach ($files as $file) {
            $extension = strtolower($file->getClientOriginalExtension());
            $fileName = $file->getClientOriginalName();
            
            if ($extension === 'md') {
                $markdownFiles[] = $file;
            } elseif (in_array($extension, ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'])) {
                $imageFiles[] = $file;
            }
        }
        
        if (empty($markdownFiles)) {
            throw new \RuntimeException("No markdown files found in folder upload");
        }
        
        // Use the first markdown file (or could merge multiple)
        $markdownFile = $markdownFiles[0];
        $markdownPath = "{$path}/folder_markdown.md";
        
        // Move markdown file
        $markdownFile->move($path, 'folder_markdown.md');
        chmod($markdownPath, 0644);
        
        Log::info('Markdown file processed', [
            'citation_id' => $citation_id,
            'markdown_file' => $markdownFile->getClientOriginalName(),
            'image_count' => count($imageFiles)
        ]);
        
        // Process image files
        foreach ($imageFiles as $imageFile) {
            $filename = $imageFile->getClientOriginalName();
            $targetPath = "{$mediaDir}/{$filename}";
            
            // Validate image file using temporary path
            if ($this->validateImageFileFromUpload($imageFile)) {
                $imageFile->move($mediaDir, $filename);
                chmod($targetPath, 0644);
                Log::debug('Image file processed', ['file' => $filename]);
            } else {
                Log::warning('Image file validation failed, skipping', ['file' => $filename]);
            }
        }
        
        // Update image references in markdown
        if (File::exists($markdownPath)) {
            $imageFilenames = array_map(function($file) {
                return $file->getClientOriginalName();
            }, $imageFiles);
            
            $this->updateMarkdownImagePaths($markdownPath, $imageFilenames, $citation_id);
            
            // Process markdown using existing pipeline
            $this->processMarkdownFile($markdownPath, $path, $citation_id);
        }
        
        Log::info('processFolderFiles completed', [
            'citation_id' => $citation_id,
            'total_duration_ms' => round((microtime(true) - $processStart) * 1000, 2)
        ]);
    }

    private function validateZipFile($file): bool
    {
        $zip = new \ZipArchive();
        $result = $zip->open($file->getPathname());
        
        if ($result !== TRUE) {
            Log::debug('ZIP validation failed: cannot open as ZIP', [
                'zip_error_code' => $result
            ]);
            return false;
        }

        $numFiles = $zip->numFiles;
        $hasMarkdown = false;
        $suspiciousFiles = 0;
        $totalSize = 0;

        // Scan all files in ZIP
        for ($i = 0; $i < $numFiles; $i++) {
            $stat = $zip->statIndex($i);
            if (!$stat) continue;

            $filename = $stat['name'];
            $filesize = $stat['size'];
            $totalSize += $filesize;

            // Check for path traversal
            if (strpos($filename, '..') !== false || strpos($filename, '/') === 0) {
                Log::warning('ZIP validation failed: suspicious path', ['filename' => $filename]);
                $suspiciousFiles++;
                continue;
            }

            // Check file extension
            $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
            
            if ($extension === 'md') {
                $hasMarkdown = true;
            } elseif (in_array($extension, ['exe', 'bat', 'sh', 'php', 'js', 'vbs', 'scr'])) {
                Log::warning('ZIP validation failed: executable file detected', ['filename' => $filename]);
                $suspiciousFiles++;
            }

            // Check individual file size (50MB max)
            if ($filesize > 50 * 1024 * 1024) {
                Log::warning('ZIP validation failed: file too large', ['filename' => $filename, 'size' => $filesize]);
                $suspiciousFiles++;
            }
        }

        $zip->close();

        // Validation rules
        if (!$hasMarkdown) {
            Log::debug('ZIP validation failed: no markdown file found');
            return false;
        }

        if ($suspiciousFiles > 0) {
            Log::warning('ZIP validation failed: suspicious files detected', ['count' => $suspiciousFiles]);
            return false;
        }

        // Check total uncompressed size (200MB max)
        if ($totalSize > 200 * 1024 * 1024) {
            Log::warning('ZIP validation failed: total size too large', ['total_size' => $totalSize]);
            return false;
        }

        return true;
    }

    private function validateImageFile(string $filePath): bool
    {
        // Check file exists and is readable
        if (!file_exists($filePath) || !is_readable($filePath)) {
            Log::warning('Image file not readable', ['path' => basename($filePath)]);
            return false;
        }

        // Check file size (10MB max for images)
        $fileSize = filesize($filePath);
        if ($fileSize > 10 * 1024 * 1024) {
            Log::warning('Image file too large', ['path' => basename($filePath), 'size' => $fileSize]);
            return false;
        }

        // Validate MIME type
        $mimeType = mime_content_type($filePath);
        $allowedMimes = [
            'image/jpeg',
            'image/png', 
            'image/gif',
            'image/webp',
            'image/svg+xml'
        ];

        if (!in_array($mimeType, $allowedMimes)) {
            Log::warning('Invalid image MIME type', ['path' => basename($filePath), 'mime' => $mimeType]);
            return false;
        }

        // For SVG, do additional content validation
        if ($mimeType === 'image/svg+xml') {
            return $this->validateSvgFile($filePath);
        }

        // Try to verify it's actually an image by reading image info
        try {
            $imageInfo = getimagesize($filePath);
            if ($imageInfo === false) {
                Log::warning('Invalid image file', ['path' => basename($filePath)]);
                return false;
            }
        } catch (\Exception $e) {
            Log::warning('Image validation exception', ['path' => basename($filePath), 'error' => $e->getMessage()]);
            return false;
        }

        return true;
    }

    private function validateImageFileFromUpload($uploadedFile): bool
    {
        // Check file size (10MB max for images)
        $fileSize = $uploadedFile->getSize();
        if ($fileSize > 10 * 1024 * 1024) {
            Log::warning('Uploaded image file too large', [
                'name' => $uploadedFile->getClientOriginalName(), 
                'size' => $fileSize
            ]);
            return false;
        }

        // Validate MIME type
        $mimeType = $uploadedFile->getMimeType();
        $allowedMimes = [
            'image/jpeg',
            'image/png', 
            'image/gif',
            'image/webp',
            'image/svg+xml'
        ];

        if (!in_array($mimeType, $allowedMimes)) {
            Log::warning('Invalid uploaded image MIME type', [
                'name' => $uploadedFile->getClientOriginalName(),
                'mime' => $mimeType
            ]);
            return false;
        }

        // For SVG, do additional content validation
        if ($mimeType === 'image/svg+xml') {
            return $this->validateSvgFileFromUpload($uploadedFile);
        }

        return true;
    }

    private function validateSvgFileFromUpload($uploadedFile): bool
    {
        $content = $uploadedFile->getContent();
        if ($content === false) {
            return false;
        }

        // Check for suspicious SVG content
        $suspiciousPatterns = [
            '/<script/i',
            '/javascript:/i',
            '/vbscript:/i',
            '/on\w+\s*=/i', // Event handlers
            '/<iframe/i',
            '/<object/i',
            '/<embed/i',
            '/<form/i',
            '/expression\s*\(/i'
        ];

        foreach ($suspiciousPatterns as $pattern) {
            if (preg_match($pattern, $content)) {
                Log::warning('Suspicious SVG content detected in upload', [
                    'name' => $uploadedFile->getClientOriginalName(),
                    'pattern' => $pattern
                ]);
                return false;
            }
        }

        return true;
    }

    private function validateSvgFile(string $filePath): bool
    {
        $content = file_get_contents($filePath);
        if ($content === false) {
            return false;
        }

        // Check for suspicious SVG content
        $suspiciousPatterns = [
            '/<script/i',
            '/javascript:/i',
            '/vbscript:/i',
            '/on\w+\s*=/i', // Event handlers
            '/<iframe/i',
            '/<object/i',
            '/<embed/i',
            '/<form/i',
            '/expression\s*\(/i'
        ];

        foreach ($suspiciousPatterns as $pattern) {
            if (preg_match($pattern, $content)) {
                Log::warning('Suspicious SVG content detected', [
                    'path' => basename($filePath),
                    'pattern' => $pattern
                ]);
                return false;
            }
        }

        return true;
    }

    private function updateMarkdownImagePaths(string $markdownPath, array $imageFiles, string $citation_id): void
    {
        $content = File::get($markdownPath);
        $updatedContent = $content;
        $updatedCount = 0;
        $renamedFiles = 0;

        // Create a map of image filenames and rename files with underscores
        $imageMap = [];
        $imageDir = dirname($markdownPath) . '/media/';
        
        foreach ($imageFiles as $imagePath) {
            $filename = basename($imagePath);
            $originalFilename = $filename;
            
            // If filename contains underscores, rename the actual file
            if (strpos($filename, '_') !== false) {
                $safeFilename = str_replace('_', '-', $filename);
                $originalPath = $imageDir . $filename;
                $safePath = $imageDir . $safeFilename;
                
                if (file_exists($originalPath)) {
                    if (rename($originalPath, $safePath)) {
                        $imageMap[$originalFilename] = $safeFilename; // Map original to safe name
                        $imageMap[$safeFilename] = $safeFilename;     // Direct mapping too
                        $renamedFiles++;
                        
                        Log::debug('Renamed image file to avoid underscores', [
                            'citation_id' => $citation_id,
                            'from' => $filename,
                            'to' => $safeFilename
                        ]);
                    } else {
                        Log::warning('Failed to rename image file', [
                            'citation_id' => $citation_id,
                            'from' => $originalPath,
                            'to' => $safePath
                        ]);
                        $imageMap[$filename] = $filename; // Keep original if rename failed
                    }
                } else {
                    $imageMap[$filename] = $safeFilename; // Assume it should be renamed
                }
            } else {
                $imageMap[$filename] = $filename; // No underscores, keep original
            }
            
            // Also map the filename without leading underscore if it exists
            if (strpos($originalFilename, '_') === 0) {
                $withoutUnderscore = ltrim($originalFilename, '_');
                $imageMap[$withoutUnderscore] = $imageMap[$originalFilename];
            }
        }
        
        Log::info('Image filename mapping created', [
            'citation_id' => $citation_id,
            'renamed_files' => $renamedFiles,
            'image_map' => $imageMap
        ]);

        // Pattern to match markdown image references: ![alt](image.jpg)
        $pattern = '/!\[([^\]]*)\]\(([^)]+)\)/';
        
        $updatedContent = preg_replace_callback($pattern, function($matches) use ($imageMap, &$updatedCount, $citation_id) {
            $altText = $matches[1];
            $imagePath = $matches[2];
            $filename = basename($imagePath);

            // Check if this image exists in our uploaded images
            if (isset($imageMap[$filename])) {
                $actualFilename = $imageMap[$filename]; // Get the actual filename (might be different if mapped)
                $newPath = "/{$citation_id}/media/{$actualFilename}"; // Use absolute path with book name
                $updatedCount++;
                
                Log::debug('Updated image reference', [
                    'citation_id' => $citation_id,
                    'from' => $imagePath,
                    'to' => $newPath,
                    'actual_filename' => $actualFilename
                ]);
                
                // Use HTML img tag directly instead of markdown to avoid underscore issues
                $htmlImg = "<img src=\"{$newPath}\" alt=\"{$altText}\" />";
                
                return $htmlImg;
            } else {
                Log::warning('Image reference not found in uploaded files', [
                    'citation_id' => $citation_id,
                    'reference' => $imagePath,
                    'filename' => $filename
                ]);
                // Keep original reference
                return $matches[0];
            }
        }, $updatedContent);

        // Save updated markdown
        File::put($markdownPath, $updatedContent);

        Log::info('Markdown image paths updated', [
            'citation_id' => $citation_id,
            'updated_references' => $updatedCount
        ]);
        
        // Debug: Show a sample of the updated markdown around images
        if ($updatedCount > 0) {
            $lines = explode("\n", $updatedContent);
            $imageLines = [];
            foreach ($lines as $lineNum => $line) {
                // Look for both markdown images and HTML img tags
                if (strpos($line, '![') !== false || strpos($line, '<img') !== false || strpos($line, 'images/') !== false) {
                    $imageLines[] = "Line " . ($lineNum + 1) . ": " . $line;
                    if (count($imageLines) >= 3) break; // Show first 3 image lines
                }
            }
            Log::info('Sample image references in updated markdown', [
                'citation_id' => $citation_id,
                'sample_lines' => $imageLines,
                'updated_count' => $updatedCount
            ]);
        }
    }

    private function fixImageReferencesInMarkdown(string $markdownPath, string $citation_id): void
    {
        // This method is now simplified since we rename actual image files 
        // in updateMarkdownImagePaths to avoid underscore issues entirely
        Log::info('Pre-conversion image fix step (now handled by file renaming)', [
            'citation_id' => $citation_id,
            'note' => 'Image files are renamed to replace underscores with hyphens during processing'
        ]);
    }

    private function recursiveDelete(string $directory): void
    {
        if (!is_dir($directory)) {
            return;
        }

        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($directory, \RecursiveDirectoryIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($iterator as $file) {
            if ($file->isDir()) {
                rmdir($file->getPathname());
            } else {
                unlink($file->getPathname());
            }
        }

        rmdir($directory);
    }

    /**
     * Generate a unique node_id in format: {book}_{timestamp}_{random}
     */
    private function generateNodeId(string $bookId): string
    {
        $timestamp = round(microtime(true) * 1000); // milliseconds
        $random = substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 9);
        return "{$bookId}_{$timestamp}_{$random}";
    }

    /**
     * Ensure content has both id and data-node-id attributes
     */
    private function ensureNodeIdInContent(string $content, int $startLine, string $nodeId): string
    {
        if (empty($content)) {
            return $content;
        }

        // Pattern to match the first opening tag
        $pattern = '/^(<[a-z][a-z0-9]*)((?:\s+[^>]*)?)(>)/i';

        $replacement = function($matches) use ($startLine, $nodeId) {
            $tagStart = $matches[1];
            $attributes = $matches[2];
            $tagEnd = $matches[3];

            // Remove existing id and data-node-id attributes
            $attributes = preg_replace('/\s+id="[^"]*"/', '', $attributes);
            $attributes = preg_replace('/\s+data-node-id="[^"]*"/', '', $attributes);

            // Add new id and data-node-id
            $newAttributes = ' id="' . $startLine . '" data-node-id="' . htmlspecialchars($nodeId, ENT_QUOTES) . '"' . $attributes;

            return $tagStart . $newAttributes . $tagEnd;
        };

        $updatedContent = preg_replace_callback($pattern, $replacement, $content, 1);

        return $updatedContent !== null ? $updatedContent : $content;
    }
}