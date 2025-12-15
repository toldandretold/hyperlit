<?php

namespace App\Services\DocumentImport\Processors;

interface ProcessorInterface
{
    /**
     * Process the input file and generate output files (nodes.json, etc.)
     *
     * @param string $inputPath Path to the input file
     * @param string $outputPath Path to the output directory
     * @param string $bookId The book identifier
     * @return void
     */
    public function process(string $inputPath, string $outputPath, string $bookId): void;

    /**
     * Get the file extensions this processor supports
     *
     * @return array<string>
     */
    public function supportedExtensions(): array;

    /**
     * Check if this processor supports the given file extension
     *
     * @param string $extension
     * @return bool
     */
    public function supports(string $extension): bool;
}
