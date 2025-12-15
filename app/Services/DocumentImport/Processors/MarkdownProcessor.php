<?php

namespace App\Services\DocumentImport\Processors;

use App\Services\DocumentImport\SanitizationService;
use App\Services\DocumentImport\FileHelpers;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class MarkdownProcessor implements ProcessorInterface
{
    public function __construct(
        private SanitizationService $sanitizer,
        private FileHelpers $helpers
    ) {}

    public function supportedExtensions(): array
    {
        return ['md'];
    }

    public function supports(string $extension): bool
    {
        return in_array(strtolower($extension), $this->supportedExtensions());
    }

    public function process(string $inputPath, string $outputPath, string $bookId): void
    {
        $processStart = microtime(true);
        $htmlOutputPath = "{$outputPath}/intermediate.html";
        $pythonScriptPath = base_path('app/Python/process_document.py');

        Log::info('MarkdownProcessor started', [
            'book' => $bookId,
            'input_file' => basename($inputPath),
            'process_start_time' => $processStart
        ]);

        try {
            // Step 1: Save original markdown for comparison
            $debugStart = microtime(true);
            $originalMarkdownContent = File::get($inputPath);
            $debugMarkdownPath = "{$outputPath}/debug_original.md";
            File::put($debugMarkdownPath, $originalMarkdownContent);

            Log::info('Debug files created', [
                'book' => $bookId,
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
            $this->sanitizer->sanitizeMarkdownFile($inputPath);
            Log::info('Markdown sanitization completed', [
                'book' => $bookId,
                'sanitize_duration_ms' => round((microtime(true) - $sanitizeStart) * 1000, 2)
            ]);

            // Step 2.5: Fix image references BEFORE markdown-to-HTML conversion
            $preConversionStart = microtime(true);
            $this->helpers->fixImageReferencesInMarkdown($inputPath, $bookId);
            Log::info('Pre-conversion image fix completed', [
                'book' => $bookId,
                'pre_conversion_duration_ms' => round((microtime(true) - $preConversionStart) * 1000, 2)
            ]);

            Log::info('Step 1: Converting Markdown to HTML...', [
                'book' => $bookId,
                'input' => basename($inputPath),
                'output' => basename($htmlOutputPath)
            ]);

            // Step 3: Convert Markdown to HTML using Python markdown
            $mdToHtmlStart = microtime(true);
            $markdownConverterPath = base_path('app/Python/simple_md_to_html.py');
            $markdownProcess = new Process([
                'python3',
                $markdownConverterPath,
                $inputPath,
                $htmlOutputPath
            ]);
            $markdownProcess->setTimeout(300); // 5 minutes timeout
            $markdownProcess->run();

            $mdToHtmlDuration = round((microtime(true) - $mdToHtmlStart) * 1000, 2);

            if (!$markdownProcess->isSuccessful()) {
                Log::error("Markdown conversion failed", [
                    'book' => $bookId,
                    'conversion_duration_ms' => $mdToHtmlDuration,
                    'stdout' => $markdownProcess->getOutput(),
                    'stderr' => $markdownProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($markdownProcess);
            }
            Log::info("Markdown to HTML conversion successful", [
                'book' => $bookId,
                'conversion_duration_ms' => $mdToHtmlDuration
            ]);

            // Save and log the HTML content for debugging footnote sections
            if (File::exists($htmlOutputPath)) {
                $htmlContent = File::get($htmlOutputPath);

                // Save a copy of the HTML for inspection
                $debugHtmlPath = "{$outputPath}/debug_converted.html";
                File::put($debugHtmlPath, $htmlContent);

                Log::info("HTML Content Generated and saved for debugging:", [
                    'book' => $bookId,
                    'debug_file_saved' => $debugHtmlPath,
                    'html_preview' => substr($htmlContent, 0, 2000),
                    'full_length' => strlen($htmlContent),
                    'contains_hr' => strpos($htmlContent, '<hr') !== false ? 'YES' : 'NO',
                    'contains_notes_headers' => preg_match('/<h[1-6][^>]*>.*notes.*<\/h[1-6]>/i', $htmlContent) ? 'YES' : 'NO',
                    'footnote_patterns' => substr_count($htmlContent, '[^') + substr_count($htmlContent, '[1]') + substr_count($htmlContent, '[2]')
                ]);
            }

            // Step 4: Run the Python script on the generated HTML
            $pythonScriptStart = microtime(true);
            Log::info("Step 2: Running Python script...", [
                'book' => $bookId,
                'script' => basename($pythonScriptPath),
                'html_input' => basename($htmlOutputPath),
                'output_dir' => basename($outputPath),
                'book_id' => $bookId,
                'python_start_time' => $pythonScriptStart
            ]);

            $pythonProcess = new Process([
                'python3',
                $pythonScriptPath,
                $htmlOutputPath,
                $outputPath,
                $bookId
            ]);
            $pythonProcess->setTimeout(300);
            $pythonProcess->run();

            $pythonScriptDuration = round((microtime(true) - $pythonScriptStart) * 1000, 2);

            if (!$pythonProcess->isSuccessful()) {
                Log::error("Python script execution failed", [
                    'book' => $bookId,
                    'python_duration_ms' => $pythonScriptDuration,
                    'stdout' => $pythonProcess->getOutput(),
                    'stderr' => $pythonProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($pythonProcess);
            }
            Log::info("Python script executed successfully", [
                'book' => $bookId,
                'python_duration_ms' => $pythonScriptDuration
            ]);

        } catch (ProcessFailedException $exception) {
            $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
            Log::error("Markdown processing failed for {$bookId}", [
                'error' => $exception->getMessage(),
                'total_process_duration_ms' => $totalProcessDuration,
                'stdout' => $exception->getProcess()->getOutput(),
                'stderr' => $exception->getProcess()->getErrorOutput(),
            ]);
            throw $exception;
        } finally {
            // Step 5: Clean up the intermediate HTML file
            $cleanupStart = microtime(true);
            if (File::exists($htmlOutputPath)) {
                File::delete($htmlOutputPath);
            }
            $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
            Log::info("MarkdownProcessor completed", [
                'book' => $bookId,
                'cleanup_duration_ms' => round((microtime(true) - $cleanupStart) * 1000, 2),
                'total_process_duration_ms' => $totalProcessDuration
            ]);
        }
    }
}
