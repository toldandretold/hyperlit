<?php

namespace App\Services\DocumentImport\Processors;

use App\Services\DocumentImport\FileHelpers;
use App\Services\DocumentImport\ValidationService;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class PdfProcessor implements ProcessorInterface
{
    use StreamsProgress;

    private ?\Closure $onProgress = null;

    public function __construct(
        private MarkdownProcessor $markdownProcessor,
        private FileHelpers $helpers,
        private ValidationService $validator
    ) {}

    public function setProgressCallback(\Closure $callback): void
    {
        $this->onProgress = $callback;
        // Propagate to the inner MarkdownProcessor
        $this->markdownProcessor->setProgressCallback($callback);
    }

    public function supportedExtensions(): array
    {
        return ['pdf'];
    }

    public function supports(string $extension): bool
    {
        return in_array(strtolower($extension), $this->supportedExtensions());
    }

    public function process(string $inputPath, string $outputPath, string $bookId): void
    {
        $processStart = microtime(true);

        Log::info('PdfProcessor started', [
            'book' => $bookId,
            'input_file' => basename($inputPath),
        ]);

        // Validate the PDF before sending to OCR API
        if (!$this->validator->validatePdfFile($inputPath)) {
            throw new \RuntimeException('Invalid PDF file: ' . basename($inputPath));
        }

        // Stage 0 (Mac-hosted backends only): produce the OCR cache locally via
        // the hyperlit-ocr CLI (Apple Vision/PDFKit — see macOShyperlit/), so
        // Stage 1 replays from it with no Mistral call. A client-uploaded
        // ocr_response.json takes precedence (never re-OCR what the app sent).
        $this->runNativeOcrIfConfigured($inputPath, $outputPath, $bookId);

        // Stage 1: Run Mistral OCR — PDF → main-text.md + media/*.jpg
        // When ocr_response.json already exists (client-side native OCR uploaded
        // with the PDF, the native CLI above, or the test-fixture side-load),
        // mistral_ocr.py replays from that cache and never calls the API — so
        // no key is needed.
        $apiKey = config('services.mistral_ocr.api_key');
        $hasOcrCache = File::exists("{$outputPath}/ocr_response.json");
        if (empty($apiKey) && !$hasOcrCache) {
            throw new \RuntimeException('MISTRAL_OCR_API_KEY is not configured');
        }

        Log::info('PDF OCR source', [
            'book' => $bookId,
            'cached' => $hasOcrCache,
        ]);

        $script = base_path('app/Python/mistral_ocr.py');
        $args = ['python3', $script, $inputPath, $outputPath];
        if (!empty($apiKey)) {
            $args = array_merge($args, ['--api-key', $apiKey]);
        }
        $process = new Process($args);
        $process->setTimeout(900);
        $this->runWithProgress($process, $this->onProgress);

        $ocrDuration = round((microtime(true) - $processStart) * 1000, 2);

        if (!$process->isSuccessful()) {
            Log::error('Mistral OCR failed', [
                'book' => $bookId,
                'ocr_duration_ms' => $ocrDuration,
                'stdout' => $process->getOutput(),
                'stderr' => $process->getErrorOutput(),
            ]);
            throw new ProcessFailedException($process);
        }

        Log::info('Mistral OCR completed', [
            'book' => $bookId,
            'ocr_duration_ms' => $ocrDuration,
            'stdout' => $process->getOutput(),
        ]);

        // Stage 2: Update image refs in markdown (like ZipProcessor does)
        $mdPath = "{$outputPath}/main-text.md";
        $mediaDir = "{$outputPath}/media";

        if (File::exists($mediaDir)) {
            // Validate each OCR image; delete any that fail
            foreach (File::files($mediaDir) as $file) {
                if (!$this->validator->validateImageFile($file->getPathname())) {
                    Log::warning('Removing invalid OCR image', ['file' => $file->getFilename()]);
                    File::delete($file->getPathname());
                }
            }

            $imageFiles = collect(File::files($mediaDir))
                ->map(fn($f) => $f->getFilename())
                ->toArray();

            if (!empty($imageFiles)) {
                $this->helpers->updateMarkdownImagePaths($mdPath, $imageFiles, $bookId);
            }
        }

        // Stage 3: Feed markdown through existing pipeline (md → html → nodes.json)
        $this->markdownProcessor->process($mdPath, $outputPath, $bookId);

        $totalDuration = round((microtime(true) - $processStart) * 1000, 2);
        Log::info('PdfProcessor completed', [
            'book' => $bookId,
            'total_duration_ms' => $totalDuration,
        ]);
    }

    /**
     * Run the on-device OCR CLI (hyperlit-ocr, Apple Vision/PDFKit) to seed
     * ocr_response.json — free OCR when the backend runs on a Mac.
     *
     * services.native_ocr.provider: 'auto' falls through to Mistral when the
     * binary is missing or fails; 'native' makes a CLI failure fatal;
     * 'mistral' disables this stage. Skipped when a cache already exists
     * (client-uploaded OCR or the test side-load takes precedence). On
     * success writes the zero-amount ocr_charged.json marker (nothing was
     * spent, so billOcrImport must not charge).
     */
    private function runNativeOcrIfConfigured(string $inputPath, string $outputPath, string $bookId): void
    {
        $provider = config('services.native_ocr.provider', 'auto');
        $binary = config('services.native_ocr.binary');
        if ($provider === 'mistral' || File::exists("{$outputPath}/ocr_response.json")) {
            return;
        }
        $binaryUsable = $binary && is_executable($binary);
        if (!$binaryUsable) {
            if ($provider === 'native') {
                throw new \RuntimeException('OCR_PROVIDER=native but NATIVE_OCR_BINARY is not configured or not executable');
            }
            return;
        }

        $ocrJson = "{$outputPath}/ocr_response.json";
        $process = new Process([$binary, $inputPath, $ocrJson, '--progress']);
        $process->setTimeout(900);
        $this->runWithProgress($process, $this->onProgress);

        if (!$process->isSuccessful() || !File::exists($ocrJson)) {
            Log::warning('Native OCR CLI failed' . ($provider === 'auto' ? ' — falling back to Mistral' : ''), [
                'book' => $bookId,
                'stderr' => $process->getErrorOutput(),
            ]);
            File::delete($ocrJson); // never leave a partial cache for stage 1
            if ($provider === 'native') {
                throw new ProcessFailedException($process);
            }
            return;
        }

        File::put("{$outputPath}/ocr_charged.json", json_encode([
            'book' => $bookId,
            'amount' => 0,
            'source' => 'server_native_ocr',
            'charged_at' => gmdate('c'),
        ], JSON_PRETTY_PRINT));
        Log::info('Native OCR produced the cache', ['book' => $bookId]);
    }
}
