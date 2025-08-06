<?php 

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Jobs\PandocConversionJob;
use App\Models\Citation;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

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
        // Simplified initial logging
        Log::info('File upload started', [
            'citation_id' => $request->input('citation_id'),
            'has_file' => $request->hasFile('markdown_file'),
            'file_size' => $request->hasFile('markdown_file') ? $request->file('markdown_file')->getSize() : null,
            'file_extension' => $request->hasFile('markdown_file') ? $request->file('markdown_file')->getClientOriginalExtension() : null
        ]);

        // Validate the request
        $request->validate([
            'citation_id' => 'required|string|regex:/^[a-zA-Z0-9_-]+$/',
            'title' => 'required|string|max:255',
            'author' => 'nullable|string|max:255',
            'year' => 'nullable|integer|min:1000|max:' . (date('Y') + 10),
            'markdown_file' => 'nullable|file|max:50000|mimes:md,doc,docx,epub'
        ]);

        $citation_id = $request->input('citation_id');

        // Sanitize citation_id to prevent path traversal
        $citation_id = preg_replace('/[^a-zA-Z0-9_-]/', '', $citation_id);

        if (empty($citation_id)) {
            return redirect()->back()->with('error', 'Invalid citation ID format.');
        }

        $path = resource_path("markdown/{$citation_id}");

        // Ensure the path is within the expected directory
        $realPath = realpath(dirname($path));
        $expectedPath = realpath(resource_path('markdown'));

        if (!$realPath || !str_starts_with($realPath, $expectedPath)) {
            return redirect()->back()->with('error', 'Invalid path detected.');
        }

        // Create the directory if it doesn't exist
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        // --- MODIFIED ---
        // We need a flag to know which file to wait for at the end.
        $isDocxProcessing = false;

        // Check if a file was uploaded
        if ($request->hasFile('markdown_file')) {
            $file = $request->file('markdown_file');

            // Enhanced file validation
            if (!$this->validateUploadedFile($file)) {
                Log::warning('File validation failed', [
                    'citation_id' => $citation_id,
                    'file_size' => $file->getSize(),
                    'mime_type' => $file->getMimeType()
                ]);
                return redirect()->back()->with('error', 'Invalid file format or content.');
            }

            $extension = strtolower($file->getClientOriginalExtension());
            $originalFilename = "original.{$extension}";
            $originalFilePath = "{$path}/{$originalFilename}";

            // Move file securely
            $file->move($path, $originalFilename);

            // Set proper file permissions
            chmod($originalFilePath, 0644);

            Log::info('File processing started', [
                'citation_id' => $citation_id,
                'extension' => $extension,
                'file_size' => filesize($originalFilePath)
            ]);

            // Process the file based on its extension
            if ($extension === 'md') {
                // For now, we keep the old MD flow. This could also be unified later.
                $this->sanitizeMarkdownFile($originalFilePath);
                File::move($originalFilePath, "{$path}/main-text.md");
                Log::info('Markdown file processed', ['citation_id' => $citation_id]);
            } elseif ($extension === 'epub') {
                // EPUB processing remains the same for now.
                $this->processEpubFile($originalFilePath, $path);
            } elseif (in_array($extension, ['doc', 'docx'])) {
                // --- MODIFIED ---
                // This is the section you couldn't find. It's now updated.
                $isDocxProcessing = true; // Set the flag

                Log::info('Dispatching unified document processing job', [
                    'citation_id' => $citation_id,
                    'input_file' => basename($originalFilePath),
                ]);

                // Dispatch the refactored job with the new, correct parameters
                PandocConversionJob::dispatch($citation_id, $originalFilePath);
            }
        } else {
            Log::debug('Creating basic markdown file', ['citation_id' => $citation_id]);
            $this->createBasicMarkdown($request, $path);
        }

        // --- MODIFIED ---
        // The waiting logic now checks for the correct output file.
        if ($isDocxProcessing) {
            // If we processed a DOCX, we wait for the new `processed.json` file.
            $finalPath = "{$path}/processed.json";
            $fileDescription = "processed.json";
        } else {
            // For all other cases (MD upload, EPUB, or no file), we wait for `main-text.md`.
            $finalPath = "{$path}/main-text.md";
            $fileDescription = "main-text.md";
        }

        $attempts = 0;
        // Wait for the correct final file to be created by the background job.
        while (!File::exists($finalPath) && $attempts < 10) { // Increased attempts for longer jobs
            Log::debug("Waiting for {$fileDescription} creation", [
                'citation_id' => $citation_id,
                'attempt' => $attempts + 1
            ]);
            sleep(2); // Increased sleep time
            $attempts++;
        }

        // Redirect to the citation page if the final file exists
        if (File::exists($finalPath)) {
            Log::info('File processing completed successfully', [
                'citation_id' => $citation_id,
                'processing_time' => ($attempts * 2) . ' seconds'
            ]);
            return redirect("/{$citation_id}")->with('success', 'File processed successfully!');
        }

        Log::error('File processing failed: Timed out waiting for output file.', [
            'citation_id' => $citation_id,
            'attempts' => $attempts,
            'expected_path' => $finalPath
        ]);
        return redirect()->back()->with('error', 'Failed to process file. It may be too large or complex. Please try again.');
    }

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
        $content = File::get($filePath);
        
        // Remove potentially dangerous HTML tags and attributes
        $content = strip_tags($content, '<h1><h2><h3><h4><h5><h6><p><br><strong><em><ul><ol><li><a><img><blockquote><code><pre>');
        
        // Remove javascript: and data: URLs
        $content = preg_replace('/(?:javascript|data|vbscript):[^"\'\s>]*/i', '', $content);
        
        File::put($filePath, $content);
        
        Log::debug('Markdown file sanitized', [
            'file_path' => basename($filePath)
        ]);
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
}