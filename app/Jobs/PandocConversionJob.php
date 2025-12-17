<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class PandocConversionJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    protected $citation_id;
    protected $inputFilePath;

    /**
     * Create a new job instance.
     *
     * @param string $citation_id
     * @param string $inputFilePath
     * @return void
     */
    public function __construct(string $citation_id, string $inputFilePath)
    {
        $this->citation_id = $citation_id;
        $this->inputFilePath = $inputFilePath;
    }

    /**
     * Execute the job.
     *
     * @return void
     */
    public function handle()
    {
        $basePath = resource_path("markdown/{$this->citation_id}");
        $htmlOutputPath = "{$basePath}/intermediate.html";
        $pythonScriptPath = base_path('app/Python/process_document.py');
        $metadataStripScript = base_path('app/Python/strip_docx_metadata.py');

        Log::info("PandocConversionJob started for citation_id: {$this->citation_id}");

        try {
            // Step 0: Strip metadata from DOCX for privacy/security
            $inputExtension = strtolower(pathinfo($this->inputFilePath, PATHINFO_EXTENSION));
            if ($inputExtension === 'docx') {
                $this->stripDocxMetadata($metadataStripScript, $this->inputFilePath);
            }

            // Step 1: Convert DOCX to HTML using Pandoc
            Log::info("Step 1: Converting DOCX to HTML...", [
                'input' => $this->inputFilePath,
                'output' => $htmlOutputPath
            ]);

            $pandocProcess = new Process([
                'pandoc',
                $this->inputFilePath,
                '-o',
                $htmlOutputPath,
                '--track-changes=accept', // Accept all track changes for clean output
                '--extract-media=' . $basePath // Extracts images to the folder
            ]);
            $pandocProcess->setTimeout(300); // 5 minutes timeout
            $pandocProcess->run();

            if (!$pandocProcess->isSuccessful()) {
                throw new ProcessFailedException($pandocProcess);
            }
            Log::info("Pandoc conversion successful.");
            
            // Step 1.5: Process extracted images and fix HTML paths
            $this->processExtractedImages($basePath, $htmlOutputPath, $this->citation_id);

            // Step 2: Run the Python script on the generated HTML
            $pythonBin = env('PYTHON_PATH', 'python3');

            Log::info("Step 2: Running Python script...", [
                'python'     => $pythonBin,
                'script'     => $pythonScriptPath,
                'html_input' => $htmlOutputPath,
                'output_dir' => $basePath,
                'book_id'    => $this->citation_id,
            ]);

            // Build the command as an array so Symfony handles quoting safely
            $pythonProcess = new Process([
                $pythonBin,
                $pythonScriptPath,
                $htmlOutputPath,
                $basePath,
                (string) $this->citation_id, // Pass citation_id as book_id
            ]);
            $pythonProcess->setTimeout(300);
            $pythonProcess->run();

            if (!$pythonProcess->isSuccessful()) {
                throw new ProcessFailedException($pythonProcess);
            }
            Log::info("Python script executed successfully. JSON files created.");

        } catch (ProcessFailedException $exception) {
            Log::error("PandocConversionJob failed for {$this->citation_id}", [
                'error' => $exception->getMessage(),
                'stdout' => $exception->getProcess()->getOutput(),
                'stderr' => $exception->getProcess()->getErrorOutput(),
            ]);
        } finally {
            // Step 3: Clean up the intermediate HTML file
            if (File::exists($htmlOutputPath)) {
                File::delete($htmlOutputPath);
                Log::info("Cleaned up intermediate file: {$htmlOutputPath}");
            }
        }
    }

    /**
     * Strip metadata from DOCX file for privacy and security
     */
    private function stripDocxMetadata(string $scriptPath, string $docxPath): void
    {
        $pythonBin = env('PYTHON_PATH', 'python3');

        Log::info("Step 0: Stripping DOCX metadata...", [
            'script' => $scriptPath,
            'docx' => $docxPath
        ]);

        $process = new Process([
            $pythonBin,
            $scriptPath,
            $docxPath // Overwrites the file in place
        ]);
        $process->setTimeout(60); // 1 minute timeout
        $process->run();

        if ($process->isSuccessful()) {
            Log::info("DOCX metadata stripped successfully");
        } else {
            // Log warning but don't fail - metadata stripping is not critical
            Log::warning("Failed to strip DOCX metadata, continuing anyway", [
                'error' => $process->getErrorOutput(),
                'output' => $process->getOutput()
            ]);
        }
    }

    /**
     * Process extracted images and fix HTML paths to use web routes
     */
    private function processExtractedImages(string $basePath, string $htmlPath, string $citationId): void
    {
        // Step 1: Rename image files with underscores to use hyphens
        $this->renameImageFiles($basePath);
        
        // Step 2: Fix HTML paths to use web routes
        $this->fixImagePathsInHtml($htmlPath, $citationId);
    }

    /**
     * Rename image files with underscores to use hyphens instead
     */
    private function renameImageFiles(string $basePath): void
    {
        $mediaDir = $basePath . '/media';
        if (!File::exists($mediaDir)) {
            Log::info('No media directory found, skipping image renaming');
            return;
        }

        $imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
        $renamedCount = 0;

        foreach (File::files($mediaDir) as $file) {
            $filename = $file->getFilename();
            $extension = strtolower($file->getExtension());

            if (in_array($extension, $imageExtensions) && strpos($filename, '_') !== false) {
                $safeFilename = str_replace('_', '-', $filename);
                $originalPath = $file->getPathname();
                $safePath = $mediaDir . '/' . $safeFilename;

                if (rename($originalPath, $safePath)) {
                    $renamedCount++;
                    Log::debug('Renamed image file', [
                        'from' => $filename,
                        'to' => $safeFilename
                    ]);
                }
            }
        }

        Log::info('Image file renaming completed', [
            'media_dir' => $mediaDir,
            'renamed_count' => $renamedCount
        ]);
    }

    /**
     * Fix image paths in HTML to use web routes instead of file system paths
     */
    private function fixImagePathsInHtml(string $htmlPath, string $citationId): void
    {
        if (!File::exists($htmlPath)) {
            Log::warning("HTML file not found for image path fixing: {$htmlPath}");
            return;
        }

        $htmlContent = File::get($htmlPath);
        $updatedCount = 0;

        // Pattern to match img tags with absolute file system paths
        $pattern = '/<img([^>]*src="[^"]*' . preg_quote($citationId, '/') . '\/media\/[^"]*"[^>]*)>/';
        
        $htmlContent = preg_replace_callback($pattern, function($matches) use (&$updatedCount, $citationId) {
            $imgTag = $matches[0];
            
            // Extract the src attribute and convert to web path
            $updatedTag = preg_replace_callback('/src="([^"]*)"/', function($srcMatch) use ($citationId) {
                $srcPath = $srcMatch[1];
                
                // If it contains the full file system path, convert to web route
                if (strpos($srcPath, '/media/') !== false) {
                    $filename = basename($srcPath);
                    // Also rename files with underscores to hyphens
                    $safeFilename = str_replace('_', '-', $filename);
                    $newSrc = "/{$citationId}/media/{$safeFilename}";
                    
                    Log::debug('Fixed image path in HTML', [
                        'original' => $srcPath,
                        'fixed' => $newSrc,
                        'citation_id' => $citationId
                    ]);
                    
                    return 'src="' . $newSrc . '"';
                }
                
                return $srcMatch[0]; // No change needed
            }, $imgTag);
            
            if ($updatedTag !== $imgTag) {
                $updatedCount++;
            }
            
            return $updatedTag;
        }, $htmlContent);

        // Save updated HTML
        File::put($htmlPath, $htmlContent);

        Log::info('Fixed image paths in HTML', [
            'citation_id' => $citationId,
            'html_file' => $htmlPath,
            'updated_images' => $updatedCount
        ]);
    }
}