<?php

namespace App\Services\DocumentImport\Processors;

use App\Services\DocumentImport\FileHelpers;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class EpubProcessor implements ProcessorInterface
{
    public function __construct(
        private FileHelpers $helpers
    ) {}

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

            $this->helpers->setSecurePermissions($epubPath);

            Log::info('EPUB extraction completed', [
                'total_files' => $numFiles,
                'skipped_files' => $skippedFiles,
                'extracted_to' => basename($epubPath)
            ]);

            // Step 1: Run epub_processor.py to convert EPUB to a single HTML file
            $this->runEpubProcessor($outputPath);

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
                    'python3',
                    $documentProcessorScript,
                    $htmlPath,
                    $outputPath,
                    $bookId
                ]);
                $process->setTimeout(300);
                $process->run();

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
    private function runEpubProcessor(string $path): void
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
}
