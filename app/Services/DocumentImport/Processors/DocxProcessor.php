<?php

namespace App\Services\DocumentImport\Processors;

use App\Jobs\PandocConversionJob;
use Illuminate\Support\Facades\Log;

class DocxProcessor implements ProcessorInterface
{
    public function supportedExtensions(): array
    {
        return ['doc', 'docx'];
    }

    public function supports(string $extension): bool
    {
        return in_array(strtolower($extension), $this->supportedExtensions());
    }

    /**
     * Process DOCX/DOC files by dispatching the PandocConversionJob
     *
     * Note: This processor dispatches a background job rather than processing synchronously.
     * The calling code should wait for the job to complete (e.g., poll for nodes.json creation).
     */
    public function process(string $inputPath, string $outputPath, string $bookId): void
    {
        $processStart = microtime(true);

        Log::info('DocxProcessor dispatching PandocConversionJob', [
            'book' => $bookId,
            'input_file' => basename($inputPath),
            'job_dispatch_time' => $processStart
        ]);

        // Dispatch the job to handle the conversion in the background
        PandocConversionJob::dispatch($bookId, $inputPath);

        Log::info('DocxProcessor job dispatched', [
            'book' => $bookId,
            'dispatch_duration_ms' => round((microtime(true) - $processStart) * 1000, 2)
        ]);
    }
}
