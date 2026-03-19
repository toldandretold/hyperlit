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
    public function __construct(
        private MarkdownProcessor $markdownProcessor,
        private FileHelpers $helpers,
        private ValidationService $validator
    ) {}

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

        // Stage 1: Run Mistral OCR — PDF → main-text.md + media/*.jpg
        $apiKey = config('services.mistral_ocr.api_key');
        if (empty($apiKey)) {
            throw new \RuntimeException('MISTRAL_OCR_API_KEY is not configured');
        }

        $script = base_path('app/Python/mistral_ocr.py');
        $process = new Process(['python3', $script, $inputPath, $outputPath, '--api-key', $apiKey]);
        $process->setTimeout(600); // 10 min for large PDFs
        $process->run();

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
}
