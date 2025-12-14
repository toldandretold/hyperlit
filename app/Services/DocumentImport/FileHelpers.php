<?php

namespace App\Services\DocumentImport;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class FileHelpers
{
    /**
     * Set secure permissions on directory and all its contents
     */
    public function setSecurePermissions(string $directory): void
    {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($directory)
        );

        $fileCount = 0;
        $dirCount = 0;

        foreach ($iterator as $file) {
            if ($file->isFile()) {
                chmod($file->getPathname(), 0644);
                $fileCount++;
            } elseif ($file->isDir()) {
                chmod($file->getPathname(), 0755);
                $dirCount++;
            }
        }

        Log::debug('File permissions set', [
            'directory' => basename($directory),
            'files_processed' => $fileCount,
            'directories_processed' => $dirCount
        ]);
    }

    /**
     * Recursively delete a directory and all its contents
     */
    public function recursiveDelete(string $directory): void
    {
        if (!is_dir($directory)) {
            return;
        }

        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($directory, \RecursiveDirectoryIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($iterator as $file) {
            if ($file->isDir()) {
                rmdir($file->getPathname());
            } else {
                unlink($file->getPathname());
            }
        }

        rmdir($directory);
    }

    /**
     * Generate a unique node_id in format: {book}_{timestamp}_{random}
     */
    public function generateNodeId(string $bookId): string
    {
        $timestamp = round(microtime(true) * 1000); // milliseconds
        $random = substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 9);
        return "{$bookId}_{$timestamp}_{$random}";
    }

    /**
     * Ensure content has both id and data-node-id attributes
     */
    public function ensureNodeIdInContent(string $content, int $startLine, string $nodeId): string
    {
        if (empty($content)) {
            return $content;
        }

        // Pattern to match the first opening tag
        $pattern = '/^(<[a-z][a-z0-9]*)((?:\s+[^>]*)?)(>)/i';

        $replacement = function($matches) use ($startLine, $nodeId) {
            $tagStart = $matches[1];
            $attributes = $matches[2];
            $tagEnd = $matches[3];

            // Remove existing id and data-node-id attributes
            $attributes = preg_replace('/\s+id="[^"]*"/', '', $attributes);
            $attributes = preg_replace('/\s+data-node-id="[^"]*"/', '', $attributes);

            // Add new id and data-node-id
            $newAttributes = ' id="' . $startLine . '" data-node-id="' . htmlspecialchars($nodeId, ENT_QUOTES) . '"' . $attributes;

            return $tagStart . $newAttributes . $tagEnd;
        };

        $updatedContent = preg_replace_callback($pattern, $replacement, $content, 1);

        return $updatedContent !== null ? $updatedContent : $content;
    }

    /**
     * Create a basic markdown file with title and metadata
     */
    public function createBasicMarkdown(Request $request, string $path): void
    {
        $title = $request->input('title') ?? 'Untitled';
        $markdownContent = "# {$title}\n\n";
        $markdownContent .= "**Author:** " . ($request->input('author') ?? 'Unknown') . "\n";
        $markdownContent .= "**Year:** " . ($request->input('year') ?? 'Unknown') . "\n";

        File::put("{$path}/main-text.md", $markdownContent);

        Log::debug('Basic markdown file created', [
            'title' => $title,
            'path' => basename($path)
        ]);
    }

    /**
     * Update image paths in markdown to point to media directory
     */
    public function updateMarkdownImagePaths(string $markdownPath, array $imageFiles, string $bookId): void
    {
        $content = File::get($markdownPath);
        $updatedContent = $content;
        $updatedCount = 0;
        $renamedFiles = 0;

        // Create a map of image filenames and rename files with underscores
        $imageMap = [];
        $imageDir = dirname($markdownPath) . '/media/';

        foreach ($imageFiles as $imagePath) {
            $filename = basename($imagePath);
            $originalFilename = $filename;

            // If filename contains underscores, rename the actual file
            if (strpos($filename, '_') !== false) {
                $safeFilename = str_replace('_', '-', $filename);
                $originalPath = $imageDir . $filename;
                $safePath = $imageDir . $safeFilename;

                if (file_exists($originalPath)) {
                    if (rename($originalPath, $safePath)) {
                        $imageMap[$originalFilename] = $safeFilename; // Map original to safe name
                        $imageMap[$safeFilename] = $safeFilename;     // Direct mapping too
                        $renamedFiles++;

                        Log::debug('Renamed image file to avoid underscores', [
                            'book' => $bookId,
                            'from' => $filename,
                            'to' => $safeFilename
                        ]);
                    } else {
                        Log::warning('Failed to rename image file', [
                            'book' => $bookId,
                            'from' => $originalPath,
                            'to' => $safePath
                        ]);
                        $imageMap[$filename] = $filename; // Keep original if rename failed
                    }
                } else {
                    $imageMap[$filename] = $safeFilename; // Assume it should be renamed
                }
            } else {
                $imageMap[$filename] = $filename; // No underscores, keep original
            }

            // Also map the filename without leading underscore if it exists
            if (strpos($originalFilename, '_') === 0) {
                $withoutUnderscore = ltrim($originalFilename, '_');
                $imageMap[$withoutUnderscore] = $imageMap[$originalFilename];
            }
        }

        Log::info('Image filename mapping created', [
            'book' => $bookId,
            'renamed_files' => $renamedFiles,
            'image_map' => $imageMap
        ]);

        // Pattern to match markdown image references: ![alt](image.jpg)
        $pattern = '/!\[([^\]]*)\]\(([^)]+)\)/';

        $updatedContent = preg_replace_callback($pattern, function($matches) use ($imageMap, &$updatedCount, $bookId) {
            $altText = $matches[1];
            $imagePath = $matches[2];
            $filename = basename($imagePath);

            // Check if this image exists in our uploaded images
            if (isset($imageMap[$filename])) {
                $actualFilename = $imageMap[$filename]; // Get the actual filename (might be different if mapped)
                $newPath = "/{$bookId}/media/{$actualFilename}"; // Use absolute path with book name
                $updatedCount++;

                Log::debug('Updated image reference', [
                    'book' => $bookId,
                    'from' => $imagePath,
                    'to' => $newPath,
                    'actual_filename' => $actualFilename
                ]);

                // Use HTML img tag directly instead of markdown to avoid underscore issues
                $htmlImg = "<img src=\"{$newPath}\" alt=\"{$altText}\" />";

                return $htmlImg;
            } else {
                Log::warning('Image reference not found in uploaded files', [
                    'book' => $bookId,
                    'reference' => $imagePath,
                    'filename' => $filename
                ]);
                // Keep original reference
                return $matches[0];
            }
        }, $updatedContent);

        // Save updated markdown
        File::put($markdownPath, $updatedContent);

        Log::info('Markdown image paths updated', [
            'book' => $bookId,
            'updated_references' => $updatedCount
        ]);

        // Debug: Show a sample of the updated markdown around images
        if ($updatedCount > 0) {
            $lines = explode("\n", $updatedContent);
            $imageLines = [];
            foreach ($lines as $lineNum => $line) {
                // Look for both markdown images and HTML img tags
                if (strpos($line, '![') !== false || strpos($line, '<img') !== false || strpos($line, 'images/') !== false) {
                    $imageLines[] = "Line " . ($lineNum + 1) . ": " . $line;
                    if (count($imageLines) >= 3) break; // Show first 3 image lines
                }
            }
            Log::info('Sample image references in updated markdown', [
                'book' => $bookId,
                'sample_lines' => $imageLines,
                'updated_count' => $updatedCount
            ]);
        }
    }

    /**
     * Fix image references in markdown before conversion
     * (Now handled by file renaming in updateMarkdownImagePaths)
     */
    public function fixImageReferencesInMarkdown(string $markdownPath, string $bookId): void
    {
        Log::info('Pre-conversion image fix step (now handled by file renaming)', [
            'book' => $bookId,
            'note' => 'Image files are renamed to replace underscores with hyphens during processing'
        ]);
    }
}
