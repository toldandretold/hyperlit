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
        $request->validate([
            'citation_id' => 'required|string|regex:/^[a-zA-Z0-9_-]+$/',
            'title' => 'required|string|max:255',
            'author' => 'nullable|string|max:255',
            'year' => 'nullable|integer|min:1000|max:' . (date('Y') + 10),
            'markdown_file' => [
                'nullable',
                'file',
                'max:50000',
                function ($attribute, $value, $fail) {
                    if ($value) {
                        $extension = strtolower($value->getClientOriginalExtension());
                        $allowedExtensions = ['md', 'doc', 'docx', 'epub'];
                        
                        Log::info('File validation debug', [
                            'original_name' => $value->getClientOriginalName(),
                            'extension' => $extension,
                            'mime_type' => $value->getMimeType(),
                            'size' => $value->getSize()
                        ]);
                        
                        if (!in_array($extension, $allowedExtensions)) {
                            $fail('The markdown file field must be a file of type: md, doc, docx, epub.');
                        }
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
            $file = $request->file('markdown_file');
            $extension = strtolower($file->getClientOriginalExtension());
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
                Log::info('Starting EPUB processing', [
                    'citation_id' => $citation_id,
                    'processing_start_time' => $processingStart
                ]);
                $this->processEpubFile($originalFilePath, $path);
                Log::info('EPUB processing completed', [
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
            }
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
                
                // Prepare data for bulk insert
                $bulkInsertStart = microtime(true);
                $insertData = [];
                $now = now();
                
                foreach ($nodeChunksData as $chunk) {
                    $insertData[] = [
                        'book' => $citation_id,
                        'startLine' => $chunk['startLine'],
                        'chunk_id' => $chunk['chunk_id'],
                        'content' => $chunk['content'],
                        'footnotes' => json_encode($chunk['footnotes'] ?? []),
                        'hyperlights' => json_encode($chunk['hyperlights'] ?? []),
                        'hypercites' => json_encode($chunk['hypercites'] ?? []),
                        'plainText' => $chunk['plainText'] ?? '',
                        'type' => $chunk['type'] ?? 'p',
                        'raw_json' => json_encode($chunk),
                        'created_at' => $now,
                        'updated_at' => $now
                    ];
                }
                
                // Bulk insert in batches of 500 to avoid memory issues
                $batchSize = 500;
                $totalInserted = 0;
                $batches = array_chunk($insertData, $batchSize);
                
                foreach ($batches as $batchIndex => $batch) {
                    $batchStart = microtime(true);
                    PgNodeChunk::insert($batch);
                    $totalInserted += count($batch);
                    
                    Log::info('Batch inserted', [
                        'citation_id' => $citation_id,
                        'batch_number' => $batchIndex + 1,
                        'batch_size' => count($batch),
                        'batch_duration_ms' => round((microtime(true) - $batchStart) * 1000, 2)
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
                    'timestamp' => round(microtime(true) * 1000),
                    'creator' => $creatorInfo['creator'],
                    'creator_token' => $creatorInfo['creator_token'],
                    'raw_json' => []
                ]
            );
            
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
            $cleanScriptPath = base_path('app/python/clean.py');
            $combineScriptPath = base_path('app/python/combine.py');
            
            // Verify script files exist
            if (!file_exists($cleanScriptPath) || !file_exists($combineScriptPath)) {
                throw new \RuntimeException('Python scripts not found');
            }

            Log::info('Python scripts execution started', [
                'epub_path' => basename($epubPath)
            ]);

            // Run clean.py with timeout and proper error handling
            $cleanProcess = new Process([
                'python3', 
                $cleanScriptPath, 
                $epubPath
            ]);
            $cleanProcess->setTimeout(300);
            $cleanProcess->run();

            if (!$cleanProcess->isSuccessful()) {
                Log::error('Clean.py script failed', [
                    'exit_code' => $cleanProcess->getExitCode(),
                    'error_output' => $cleanProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($cleanProcess);
            }

            // Run combine.py
            $combineProcess = new Process([
                'python3', 
                $combineScriptPath, 
                $epubPath
            ]);
            $combineProcess->setTimeout(300);
            $combineProcess->run();

            if (!$combineProcess->isSuccessful()) {
                Log::error('Combine.py script failed', [
                    'exit_code' => $combineProcess->getExitCode(),
                    'error_output' => $combineProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($combineProcess);
            }

            Log::info('Python scripts completed successfully');

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
            'application/epub+zip'
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

    private function processEpubFile(string $originalFilePath, string $path): void
    {
        $epubPath = "{$path}/epub_original";
        
        if (!File::exists($epubPath)) {
            File::makeDirectory($epubPath, 0755, true);
        }

        $zip = new \ZipArchive();
        if ($zip->open($originalFilePath) === TRUE) {
            $skippedFiles = 0;
            
            // Extract with size limits to prevent zip bombs
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $stat = $zip->statIndex($i);
                
                // Skip files that are too large (prevent zip bombs)
                if ($stat['size'] > 10 * 1024 * 1024) { // 10MB per file
                    Log::warning('Skipping large file in EPUB', [
                        'filename' => $stat['name'],
                        'size' => $stat['size']
                    ]);
                    $skippedFiles++;
                    continue;
                }
                
                // Skip files with suspicious paths
                if (strpos($stat['name'], '..') !== false || strpos($stat['name'], '/') === 0) {
                    Log::warning('Skipping suspicious file path in EPUB', [
                        'filename' => $stat['name']
                    ]);
                    $skippedFiles++;
                    continue;
                }
            }
            
            $zip->extractTo($epubPath);
            $zip->close();
            
            $this->setSecurePermissions($epubPath);
            
            Log::info('EPUB extraction completed', [
                'total_files' => $zip->numFiles,
                'skipped_files' => $skippedFiles,
                'extracted_to' => basename($epubPath)
            ]);
            
            $this->runPythonScripts($path);
        } else {
            Log::error('Failed to open EPUB file', [
                'file_path' => basename($originalFilePath)
            ]);
            throw new \RuntimeException("Failed to extract EPUB file");
        }
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
}