<?php

namespace App\Services\DocumentImport\Processors;

use App\Services\DocumentImport\ValidationService;
use App\Services\DocumentImport\FileHelpers;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class ZipProcessor implements ProcessorInterface
{
    public function __construct(
        private ValidationService $validator,
        private FileHelpers $helpers,
        private MarkdownProcessor $markdownProcessor
    ) {}

    public function supportedExtensions(): array
    {
        return ['zip'];
    }

    public function supports(string $extension): bool
    {
        return in_array(strtolower($extension), $this->supportedExtensions());
    }

    public function process(string $inputPath, string $outputPath, string $bookId): void
    {
        $processStart = microtime(true);
        $extractPath = "{$outputPath}/folder_extracted";

        Log::info('ZipProcessor started', [
            'book' => $bookId,
            'zip_file' => basename($inputPath),
            'process_start_time' => $processStart
        ]);

        // Create extraction directory
        if (!File::exists($extractPath)) {
            File::makeDirectory($extractPath, 0755, true);
        }

        try {
            // Extract ZIP file
            $zip = new \ZipArchive();
            if ($zip->open($inputPath) === TRUE) {
                $numFiles = $zip->numFiles;
                $skippedFiles = 0;
                $markdownFile = null;
                $imageFiles = [];

                // Pre-validation: scan for MD file and images
                for ($i = 0; $i < $numFiles; $i++) {
                    $stat = $zip->statIndex($i);
                    if (!$stat) continue;

                    $filename = $stat['name'];
                    $filesize = $stat['size'];

                    // Security checks
                    if ($filesize > 50 * 1024 * 1024) { // 50MB per file
                        Log::warning('Skipping large file in ZIP', ['filename' => $filename, 'size' => $filesize]);
                        $skippedFiles++;
                        continue;
                    }

                    if (strpos($filename, '..') !== false || strpos($filename, '/') === 0) {
                        Log::warning('Skipping suspicious file path in ZIP', ['filename' => $filename]);
                        $skippedFiles++;
                        continue;
                    }

                    // Check file types
                    $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
                    if ($extension === 'md') {
                        if ($markdownFile === null) {
                            $markdownFile = $filename;
                        } else {
                            Log::warning('Multiple MD files found, using first: ' . $markdownFile);
                        }
                    } elseif (in_array($extension, ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'])) {
                        $imageFiles[] = $filename;
                    }
                }

                // Validate we have required files
                if (!$markdownFile) {
                    throw new \RuntimeException("No markdown (.md) file found in ZIP");
                }

                Log::info('ZIP file analysis completed', [
                    'book' => $bookId,
                    'markdown_file' => $markdownFile,
                    'image_count' => count($imageFiles),
                    'skipped_files' => $skippedFiles
                ]);

                // Extract all files
                $zip->extractTo($extractPath);
                $zip->close();

                // Set secure permissions
                $this->helpers->setSecurePermissions($extractPath);

                // Create media directory in final location
                $mediaDir = "{$outputPath}/media";
                if (!File::exists($mediaDir)) {
                    File::makeDirectory($mediaDir, 0755, true);
                }

                // Process images with security validation
                foreach ($imageFiles as $imageFile) {
                    $sourcePath = "{$extractPath}/{$imageFile}";
                    $targetPath = "{$mediaDir}/" . basename($imageFile);

                    if (File::exists($sourcePath)) {
                        // Validate image file
                        if ($this->validator->validateImageFile($sourcePath)) {
                            File::copy($sourcePath, $targetPath);
                            chmod($targetPath, 0644);
                            Log::debug('Image copied', ['from' => $imageFile, 'to' => basename($targetPath)]);
                        } else {
                            Log::warning('Image validation failed, skipping', ['file' => $imageFile]);
                        }
                    }
                }

                // Process the markdown file
                $markdownPath = "{$extractPath}/{$markdownFile}";
                if (File::exists($markdownPath)) {
                    // Update image references in markdown to point to media/ directory
                    $this->helpers->updateMarkdownImagePaths($markdownPath, $imageFiles, $bookId);

                    // Process markdown using existing pipeline
                    $this->markdownProcessor->process($markdownPath, $outputPath, $bookId);
                } else {
                    throw new \RuntimeException("Markdown file not found after extraction: {$markdownFile}");
                }

                // Clean up extraction directory
                $this->helpers->recursiveDelete($extractPath);

            } else {
                throw new \RuntimeException("Failed to open ZIP file");
            }

        } catch (\Exception $e) {
            Log::error("Folder upload processing failed", [
                'book' => $bookId,
                'error' => $e->getMessage(),
                'process_duration_ms' => round((microtime(true) - $processStart) * 1000, 2)
            ]);

            // Clean up on failure
            if (File::exists($extractPath)) {
                $this->helpers->recursiveDelete($extractPath);
            }

            throw $e;
        }

        Log::info('ZipProcessor completed successfully', [
            'book' => $bookId,
            'total_duration_ms' => round((microtime(true) - $processStart) * 1000, 2)
        ]);
    }

    /**
     * Process multiple uploaded files (folder upload without ZIP)
     */
    public function processFolderFiles(array $files, string $outputPath, string $bookId): void
    {
        $processStart = microtime(true);
        $markdownFiles = [];
        $imageFiles = [];

        Log::info('processFolderFiles started', [
            'book' => $bookId,
            'file_count' => count($files),
            'process_start_time' => $processStart
        ]);

        // Create media directory
        $mediaDir = "{$outputPath}/media";
        if (!File::exists($mediaDir)) {
            File::makeDirectory($mediaDir, 0755, true);
        }

        // Separate markdown and image files
        foreach ($files as $file) {
            $extension = strtolower($file->getClientOriginalExtension());
            $fileName = $file->getClientOriginalName();

            if ($extension === 'md') {
                $markdownFiles[] = $file;
            } elseif (in_array($extension, ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'])) {
                $imageFiles[] = $file;
            }
        }

        if (empty($markdownFiles)) {
            throw new \RuntimeException("No markdown files found in folder upload");
        }

        // Use the first markdown file (or could merge multiple)
        $markdownFile = $markdownFiles[0];
        $markdownPath = "{$outputPath}/folder_markdown.md";

        // Move markdown file
        $markdownFile->move($outputPath, 'folder_markdown.md');
        chmod($markdownPath, 0644);

        Log::info('Markdown file processed', [
            'book' => $bookId,
            'markdown_file' => $markdownFile->getClientOriginalName(),
            'image_count' => count($imageFiles)
        ]);

        // Process image files
        foreach ($imageFiles as $imageFile) {
            $filename = $imageFile->getClientOriginalName();
            $targetPath = "{$mediaDir}/{$filename}";

            // Validate image file using temporary path
            if ($this->validator->validateImageFileFromUpload($imageFile)) {
                $imageFile->move($mediaDir, $filename);
                chmod($targetPath, 0644);
                Log::debug('Image file processed', ['file' => $filename]);
            } else {
                Log::warning('Image file validation failed, skipping', ['file' => $filename]);
            }
        }

        // Update image references in markdown
        if (File::exists($markdownPath)) {
            $imageFilenames = array_map(function($file) {
                return $file->getClientOriginalName();
            }, $imageFiles);

            $this->helpers->updateMarkdownImagePaths($markdownPath, $imageFilenames, $bookId);

            // Process markdown using existing pipeline
            $this->markdownProcessor->process($markdownPath, $outputPath, $bookId);
        }

        Log::info('processFolderFiles completed', [
            'book' => $bookId,
            'total_duration_ms' => round((microtime(true) - $processStart) * 1000, 2)
        ]);
    }
}
