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

    private const VENV_PYTHON = '/var/www/hyperlit/venv/bin/python3';
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

            // Step 1.1: Work on a COPY, never the original. The steps below
            // (ar5iv preprocessing, sanitization) overwrite their input file in
            // place, and ar5iv_preprocessor's footnote rewrite is one-way — it
            // pulls <span class="ltx_note"> definition bodies out into
            // footnotes.json and deletes them from the HTML. If we mutated
            // original.html, a later reconvert (which reuses original.html on
            // disk) would re-run on the already-stripped file and silently lose
            // every footnote. Keeping original.html pristine makes reconvert
            // lossless. Mirrors PandocConversionJob, which already processes an
            // intermediate.html and leaves original.docx untouched.
            $workPath = "{$outputPath}/intermediate.html";
            File::put($workPath, $originalHtmlContent);

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
                $workPath,
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
            $this->sanitizer->sanitizeHtmlFile($workPath);
            Log::info('HTML sanitization completed', [
                'book' => $bookId,
                'sanitize_duration_ms' => round((microtime(true) - $sanitizeStart) * 1000, 2)
            ]);

            // Step 3: Run the shared document processor — the SAME engine EPUB,
            // DOCX, PDF and Markdown imports use (app/Python/process_document.py).
            // It extracts class-less "[N]: ..." footnote definitions, links bare
            // <sup>N</sup> references, detects sectioned vs whole-document layouts,
            // and streams nodes.jsonl / footnotes.jsonl / references.json directly.
            //
            // This replaces the legacy preprocess_html.py + html_footnote_processor.py
            // pair, which only matched footnotes that already carried Hyperlit's own
            // "fn-group" CSS classes — so any externally-authored HTML (a Calibre /
            // pandoc / EPUB-to-single-HTML export with plain <sup> markers) silently
            // produced zero footnotes. Routing raw HTML through process_document.py
            // gives it the full footnote intelligence the other formats already had.
            $pythonScriptStart = microtime(true);

            Log::info("Running shared document processor on HTML...", [
                'book' => $bookId,
                'script' => basename($pythonScriptPath),
                'html_input' => basename($workPath),
                'output_dir' => basename($outputPath),
                'python_start_time' => $pythonScriptStart
            ]);

            $pythonProcess = new Process([
                $this->getPythonPath(),
                $pythonScriptPath,
                $workPath,
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
            $totalProcessDuration = round((microtime(true) - $processStart) * 1000, 2);
            Log::info("HtmlProcessor completed", [
                'book' => $bookId,
                'total_process_duration_ms' => $totalProcessDuration
            ]);
        }
    }

    /**
     * Get the Python executable path — uses the prod virtualenv when present (so
     * process_document.py finds its PIL/bleach dependencies), else system python3.
     * Mirrors EpubProcessor, which runs the same script.
     */
    private function getPythonPath(): string
    {
        if (file_exists(self::VENV_PYTHON)) {
            return self::VENV_PYTHON;
        }
        return 'python3';
    }
}
