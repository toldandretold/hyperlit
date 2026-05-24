<?php

namespace App\Services\DocumentImport\Processors;

use App\Services\DocumentImport\SanitizationService;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class HtmlProcessor implements ProcessorInterface
{
    use StreamsProgress;

    private ?\Closure $onProgress = null;

    public function __construct(
        private SanitizationService $sanitizer
    ) {}

    public function setProgressCallback(\Closure $callback): void
    {
        $this->onProgress = $callback;
    }

    public function supportedExtensions(): array
    {
        return ['html', 'htm'];
    }

    public function supports(string $extension): bool
    {
        return in_array(strtolower($extension), $this->supportedExtensions());
    }

    public function process(string $inputPath, string $outputPath, string $bookId): void
    {
        $processStart = microtime(true);
        $pythonScriptPath = base_path('app/Python/process_document.py');

        Log::info('HtmlProcessor started', [
            'book' => $bookId,
            'input_file' => basename($inputPath),
            'process_start_time' => $processStart
        ]);

        try {
            // Step 1: Save original HTML for comparison
            $debugStart = microtime(true);
            $originalHtmlContent = File::get($inputPath);
            $debugHtmlPath = "{$outputPath}/debug_original.html";
            File::put($debugHtmlPath, $originalHtmlContent);

            Log::info('Debug files created', [
                'book' => $bookId,
                'debug_duration_ms' => round((microtime(true) - $debugStart) * 1000, 2)
            ]);

            Log::info("Original HTML saved for debugging:", [
                'debug_file' => $debugHtmlPath,
                'html_preview' => substr($originalHtmlContent, 0, 1000),
                'full_length' => strlen($originalHtmlContent),
                'contains_script_tags' => substr_count(strtolower($originalHtmlContent), '<script'),
                'contains_footnotes' => preg_match_all('/\[(?:\^|\d+)\]/', $originalHtmlContent, $matches)
            ]);

            // Step 1.5: ar5iv-specific preprocessing (no-op for non-ar5iv HTML).
            // Rewrites LaTeXML's <cite>/<li class="ltx_bibitem"> into Hyperlit's
            // in-text-citation/bib-entry shape and writes references.json. Runs
            // BEFORE sanitization because HTMLPurifier strips ltx_* class attributes;
            // we need to translate those classes to Hyperlit's internal ones first
            // (which are allowlisted in SanitizationService).
            $ar5ivStart = microtime(true);
            $ar5ivScriptPath = base_path('app/Python/ar5iv_preprocessor.py');
            $ar5ivProcess = new Process([
                'python3',
                $ar5ivScriptPath,
                $inputPath,
                $outputPath,
            ]);
            $ar5ivProcess->setTimeout(300);
            $ar5ivProcess->run();
            if (!$ar5ivProcess->isSuccessful()) {
                Log::warning('ar5iv preprocessor failed (continuing without it)', [
                    'book' => $bookId,
                    'stderr' => $ar5ivProcess->getErrorOutput(),
                ]);
            } else {
                Log::info('ar5iv preprocessor completed', [
                    'book' => $bookId,
                    'duration_ms' => round((microtime(true) - $ar5ivStart) * 1000, 2),
                    'stdout' => trim($ar5ivProcess->getOutput()),
                ]);
            }

            // Step 2: Sanitize the HTML file
            $sanitizeStart = microtime(true);
            $this->sanitizer->sanitizeHtmlFile($inputPath);
            Log::info('HTML sanitization completed', [
                'book' => $bookId,
                'sanitize_duration_ms' => round((microtime(true) - $sanitizeStart) * 1000, 2)
            ]);

            // Step 3: Preprocess HTML - normalize IDs and extract footnotes
            $preprocessStart = microtime(true);
            $preprocessorPath = base_path('app/Python/preprocess_html.py');
            $preprocessedHtmlPath = "{$outputPath}/preprocessed.html";

            Log::info("Running HTML preprocessor...", [
                'book' => $bookId,
                'preprocessor' => basename($preprocessorPath),
                'input' => basename($inputPath),
                'output' => basename($preprocessedHtmlPath)
            ]);

            $preprocessProcess = new Process([
                'python3',
                $preprocessorPath,
                $inputPath,
                $preprocessedHtmlPath
            ]);
            $preprocessProcess->setTimeout(900);
            $preprocessProcess->run();

            $preprocessDuration = round((microtime(true) - $preprocessStart) * 1000, 2);

            if (!$preprocessProcess->isSuccessful()) {
                Log::error("HTML preprocessing failed", [
                    'book' => $bookId,
                    'preprocess_duration_ms' => $preprocessDuration,
                    'stdout' => $preprocessProcess->getOutput(),
                    'stderr' => $preprocessProcess->getErrorOutput()
                ]);
                throw new ProcessFailedException($preprocessProcess);
            }

            Log::info("HTML preprocessing completed", [
                'book' => $bookId,
                'preprocess_duration_ms' => $preprocessDuration,
                'stdout' => $preprocessProcess->getOutput()
            ]);

            // Step 4: Run the dedicated HTML footnote processor
            $pythonScriptStart = microtime(true);
            $htmlProcessorPath = base_path('app/Python/html_footnote_processor.py');

            Log::info("Running dedicated HTML footnote processor...", [
                'book' => $bookId,
                'script' => basename($htmlProcessorPath),
                'html_input' => basename($preprocessedHtmlPath),
                'output_dir' => basename($outputPath),
                'book_id' => $bookId,
                'python_start_time' => $pythonScriptStart
            ]);

            $pythonProcess = new Process([
                'python3',
                $htmlProcessorPath,
                $preprocessedHtmlPath,
                $outputPath,
                $bookId
            ]);
            $pythonProcess->setTimeout(900);
            $this->runWithProgress($pythonProcess, $this->onProgress);

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

            // Step 5: Convert nodes.json + footnotes.json (arrays) into nodes.jsonl + footnotes.jsonl.
            // ProcessDocumentImportJob streams the JSONL forms, but html_footnote_processor.py only
            // emits the array variants — so without this step the downstream save would 404.
            $this->writeJsonlAlongsideJson("{$outputPath}/nodes.json", "{$outputPath}/nodes.jsonl");
            $this->writeJsonlAlongsideJson("{$outputPath}/footnotes.json", "{$outputPath}/footnotes.jsonl");

        } catch (ProcessFailedException $exception) {
            $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
            Log::error("HTML processing failed for {$bookId}", [
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
            Log::info("HtmlProcessor completed", [
                'book' => $bookId,
                'total_process_duration_ms' => $totalProcessDuration
            ]);
        }
    }

    /**
     * Convert a JSON array file into a JSONL file (one object per line). Used to bridge
     * html_footnote_processor.py's array output to the JSONL stream the import job expects.
     */
    private function writeJsonlAlongsideJson(string $jsonPath, string $jsonlPath): void
    {
        if (!File::exists($jsonPath)) {
            return;
        }
        $data = json_decode(File::get($jsonPath), true);
        if (!is_array($data)) {
            return;
        }
        $out = fopen($jsonlPath, 'w');
        try {
            foreach ($data as $row) {
                fwrite($out, json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
            }
        } finally {
            fclose($out);
        }
    }
}
