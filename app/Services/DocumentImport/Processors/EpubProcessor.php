<?php

namespace App\Services\DocumentImport\Processors;

use App\Services\DocumentImport\FileHelpers;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class EpubProcessor implements ProcessorInterface
{
    use StreamsProgress;

    private const VENV_PYTHON = '/var/www/hyperlit/venv/bin/python3';
    private ?\Closure $onProgress = null;

    public function __construct(
        private FileHelpers $helpers
    ) {}

    public function setProgressCallback(\Closure $callback): void
    {
        $this->onProgress = $callback;
    }

    /**
     * Get the Python executable path - uses venv on prod, system python locally
     */
    private function getPythonPath(): string
    {
        if (file_exists(self::VENV_PYTHON)) {
            return self::VENV_PYTHON;
        }
        return 'python3';
    }

    public function supportedExtensions(): array
    {
        return ['epub'];
    }

    public function supports(string $extension): bool
    {
        return in_array(strtolower($extension), $this->supportedExtensions());
    }

    public function process(string $inputPath, string $outputPath, string $bookId): void
    {
        $processStart = microtime(true);
        $epubPath = "{$outputPath}/epub_original";

        Log::info('EpubProcessor started', [
            'book' => $bookId,
            'input_file' => basename($inputPath),
            'process_start_time' => $processStart
        ]);

        if (!File::exists($epubPath)) {
            File::makeDirectory($epubPath, 0755, true);
        }

        $zip = new \ZipArchive();
        if ($zip->open($inputPath) === TRUE) {
            $numFiles = $zip->numFiles;
            $skippedFiles = 0;
            $safeFiles = [];

            // Build an allow-list of safe entries. This filter is REAL: only the
            // entries collected here are extracted (see the per-file extractTo
            // below). Previously this loop merely LOGGED "suspicious" entries and
            // then `extractTo($epubPath)` unpacked the ENTIRE archive regardless —
            // security theatre that relied wholly on libzip sanitising paths. We
            // now reject traversal ourselves and verify each file post-extraction,
            // matching ZipProcessor.
            for ($i = 0; $i < $numFiles; $i++) {
                $stat = $zip->statIndex($i);
                if (!$stat) continue;
                $name = $stat['name'];

                // Directory entries are created implicitly when files are written.
                if (substr($name, -1) === '/') continue;

                if ($stat['size'] > 10 * 1024 * 1024) { // 10MB per file
                    Log::warning('Skipping large file in EPUB', ['filename' => $name, 'size' => $stat['size']]);
                    $skippedFiles++;
                    continue;
                }
                // Reject path traversal / absolute / backslash / null-byte names —
                // do NOT trust libzip to sanitise them.
                if (strpos($name, '..') !== false
                    || strpos($name, '/') === 0
                    || strpos($name, '\\') !== false
                    || strpos($name, "\0") !== false) {
                    Log::warning('Blocking suspicious file path in EPUB', ['filename' => $name]);
                    $skippedFiles++;
                    continue;
                }
                $safeFiles[] = $name;
            }

            // Extract ONLY allow-listed entries, verifying each stays inside the dir.
            foreach ($safeFiles as $safeFile) {
                $zip->extractTo($epubPath, $safeFile);

                $extractedPath = $epubPath . '/' . $safeFile;
                if (file_exists($extractedPath)) {
                    $realPath = realpath($extractedPath);
                    $realDir  = realpath($epubPath);
                    if (!$realPath || !$realDir || strpos($realPath, $realDir) !== 0) {
                        Log::error('EPUB extraction path escape detected', [
                            'file' => $safeFile, 'realpath' => $realPath, 'expected_base' => $realDir,
                        ]);
                        @unlink($extractedPath);
                        throw new \RuntimeException('Security violation: EPUB entry escapes target directory');
                    }
                }
            }
            $zip->close();

            // Remove any symlinks the archive planted (could be written through later).
            $this->removeSymlinks($epubPath);

            $this->helpers->setSecurePermissions($epubPath);

            Log::info('EPUB extraction completed', [
                'total_files' => $numFiles,
                'skipped_files' => $skippedFiles,
                'extracted_to' => basename($epubPath)
            ]);

            // Step 1: Run epub_processor.py to convert EPUB to a single HTML file
            $this->runEpubProcessor($outputPath, $bookId);

            // Step 2: Process the generated HTML to create node chunks, footnotes, etc.
            $htmlPath = "{$outputPath}/main-text.html";
            if (File::exists($htmlPath)) {
                $documentProcessorScript = base_path('app/Python/process_document.py');

                Log::info("Running document processor on EPUB-generated HTML", [
                    'book' => $bookId,
                    'script' => basename($documentProcessorScript),
                    'html_input' => basename($htmlPath)
                ]);

                $process = new Process([
                    $this->getPythonPath(),
                    $documentProcessorScript,
                    $htmlPath,
                    $outputPath,
                    $bookId
                ]);
                $process->setTimeout(900);
                $this->runWithProgress($process, $this->onProgress);

                if (!$process->isSuccessful()) {
                    Log::error("Python script process_document.py failed for EPUB", [
                        'book' => $bookId,
                        'stdout' => $process->getOutput(),
                        'stderr' => $process->getErrorOutput()
                    ]);
                    throw new ProcessFailedException($process);
                }
                Log::info("Python script process_document.py executed successfully for EPUB", ['book' => $bookId]);

            } else {
                Log::error('main-text.html not found after EPUB processing.', [
                    'book' => $bookId,
                    'expected_path' => $htmlPath
                ]);
                throw new \RuntimeException("main-text.html not found after EPUB processing.");
            }

        } else {
            Log::error('Failed to open EPUB file', [
                'file_path' => basename($inputPath)
            ]);
            throw new \RuntimeException("Failed to extract EPUB file");
        }

        $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
        Log::info('EpubProcessor completed', [
            'book' => $bookId,
            'total_process_duration_ms' => $totalProcessDuration
        ]);
    }

    /**
     * Run the epub_processor.py script to convert EPUB to HTML
     */
    private function runEpubProcessor(string $path, string $bookId): void
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
            $processorScriptPath = base_path('app/Python/epub_normalizer.py');

            // Verify script file exists
            if (!file_exists($processorScriptPath)) {
                throw new \RuntimeException('Python script epub_normalizer.py not found');
            }

            Log::info('Python epub_normalizer.py execution started', [
                'epub_path' => basename($epubPath)
            ]);

            // Run epub_processor.py with timeout and proper error handling
            $process = new Process([
                $this->getPythonPath(),
                $processorScriptPath,
                $epubPath,
                $path,      // output directory
                $bookId     // book ID for image storage
            ]);
            $process->setTimeout(900);
            $this->runWithProgress($process, $this->onProgress);

            // Always log the output for debugging purposes
            $stdout = $process->getOutput();
            $stderr = $process->getErrorOutput();
            if (!empty($stdout) || !empty($stderr)) {
                Log::debug('Output from epub_normalizer.py', [
                    'stdout' => $stdout,
                    'stderr' => $stderr
                ]);
            }

            if (!$process->isSuccessful()) {
                Log::error('epub_normalizer.py script failed', [
                    'exit_code' => $process->getExitCode(),
                    'error_output' => $stderr
                ]);
                throw new ProcessFailedException($process);
            }

            Log::info('Python epub_normalizer.py completed successfully');

        } catch (ProcessFailedException $e) {
            Log::error('Python script execution failed', [
                'error' => $e->getMessage(),
                'path' => basename($path)
            ]);
            throw $e;
        }
    }

    /**
     * Recursively remove any symlinks from an extracted directory. A crafted EPUB
     * can contain a symlink entry pointing outside the tree; left in place, a
     * later write "through" it would escape. Mirrors ZipProcessor::validateNoSymlinks.
     */
    private function removeSymlinks(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($iterator as $file) {
            if (is_link($file->getPathname())) {
                Log::warning('Removing symlink from extracted EPUB', ['symlink' => $file->getPathname()]);
                @unlink($file->getPathname());
            }
        }
    }
}
