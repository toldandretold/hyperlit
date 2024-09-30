<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Symfony\Component\Process\Process;
use Illuminate\Support\Facades\Log;

class PandocConversionJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    protected $filePath;
    protected $outputPath;

    public function __construct($filePath, $outputPath)
    {
        $this->filePath = $filePath;
        $this->outputPath = $outputPath;
    }

    public function handle()
    {
        Log::info("Pandoc conversion started for input: {$this->filePath}, output: {$this->outputPath}");

        // Step 1: Run the Pandoc conversion process
        $process = new Process(['/usr/local/bin/pandoc', $this->filePath, '-o', $this->outputPath, '--wrap=none', '--from=markdown-smart']);
        $process->setTimeout(300);  // Set a timeout of 5 minutes
        $process->run();

        if (!$process->isSuccessful()) {
            Log::error('Pandoc conversion failed:', ['error' => $process->getErrorOutput()]);
            return; // Exit if Pandoc conversion fails
        }

        Log::info('Pandoc conversion successful:', ['output' => $process->getOutput()]);

        // Step 2: Check if the output file exists before cleaning
        if (!file_exists($this->outputPath)) {
            Log::error("Markdown file not found: {$this->outputPath}");
            return;
        }

        Log::info("Markdown file found, starting cleanup for: {$this->outputPath}");

        // Step 3: Clean the markdown file (do this only once)
        $this->cleanMarkdownFile($this->outputPath);
    }

    /**
     * Cleans the Markdown file by performing all necessary cleanup operations
     */
    protected function cleanMarkdownFile($outputPath)
    {
        Log::info("Attempting markdown file cleanup at path: {$outputPath}");

        if (!file_exists($outputPath)) {
            Log::error("Markdown file does not exist: {$outputPath}");
            return;
        }

        if (!is_readable($outputPath)) {
            Log::error("Markdown file is not readable: {$outputPath}");
            return;
        }

        $content = file_get_contents($outputPath);
        if ($content === false) {
            Log::error("Failed to read the markdown file: {$outputPath}");
            return;
        }

        Log::info("Successfully read the markdown file. Starting combined cleanup...");

        // Step 1: Perform both line break and attribute cleanup
        $cleanedContent = $this->performCombinedCleanup($content);

        // Check if content was modified
        if ($cleanedContent !== $content) {
            Log::info("Content has been modified, writing cleaned content back to file.");
            $writeSuccess = file_put_contents($outputPath, $cleanedContent);

            if ($writeSuccess === false) {
                Log::error("Failed to write cleaned content back to the file: {$outputPath}");
            } else {
                Log::info("Markdown file cleaned successfully: {$outputPath}");
            }
        } else {
            Log::info("No changes made to the content, skipping file write.");
        }
    }

    /**
     * Combines line break removal and unwanted attribute removal in one step
     */
    protected function performCombinedCleanup($content)
    {
        Log::info("Starting combined cleanup process...");

        // Step 1: Remove unnecessary line breaks
        $lines = explode("\n", $content);
        $cleanedLines = [];
        $isInBlockQuote = false;
        $currentParagraph = '';

        foreach ($lines as $line) {
            $trimmedLine = trim($line);

            // Check if the line starts a blockquote
            if (preg_match('/^>/', $trimmedLine)) {
                $isInBlockQuote = true;
            } else {
                $isInBlockQuote = false;
            }

            // If inside blockquote or normal paragraph
            if ($isInBlockQuote) {
                // Remove unnecessary line breaks inside block quotes
                if (!empty($trimmedLine)) {
                    if (!empty($currentParagraph)) {
                        // Append the line to the current blockquote paragraph
                        $currentParagraph .= ' ' . preg_replace('/^>/', '', $trimmedLine);
                    } else {
                        $currentParagraph = $trimmedLine;
                    }
                } else {
                    // Add the finished blockquote paragraph and reset
                    if (!empty($currentParagraph)) {
                        $cleanedLines[] = $currentParagraph;
                        $currentParagraph = '';
                    }
                    $cleanedLines[] = '';
                }
            } else {
                // Handle normal paragraphs
                if (!empty($trimmedLine)) {
                    if (!empty($currentParagraph)) {
                        // Append the line to the current paragraph
                        $currentParagraph .= ' ' . $trimmedLine;
                    } else {
                        $currentParagraph = $trimmedLine;
                    }
                } else {
                    // Add the finished paragraph and reset
                    if (!empty($currentParagraph)) {
                        $cleanedLines[] = $currentParagraph;
                        $currentParagraph = '';
                    }
                    $cleanedLines[] = '';
                }
            }
        }

        // Add any remaining content in the paragraph
        if (!empty($currentParagraph)) {
            $cleanedLines[] = $currentParagraph;
        }

        // Join the cleaned lines back together with line breaks
        $cleanedContent = implode("\n", $cleanedLines);

        // Step 2: Remove unwanted attributes (like {dir="rtl"})
        Log::info("Removing unwanted Pandoc artifacts...");
        $cleanedContent = preg_replace('/\{dir="rtl"\}/', '', $cleanedContent);

        // Step 3: Indent footnotes
        Log::info("Indenting footnotes...");
        $pattern = '/(\[\^[0-9]+\]:\s*)(.*?)(?=\n\[\^|\z)/s';  // Match footnotes until the next footnote or end of content
        $cleanedContent = preg_replace_callback($pattern, function ($matches) {
            // Split the footnote content into paragraphs
            $footnoteContent = trim($matches[2]);  // Trim extra spaces
            $paragraphs = preg_split('/\n{2,}/', $footnoteContent);  // Split by double newlines to detect paragraphs

            // Ensure all subsequent paragraphs are indented with four spaces
            $indentedParagraphs = array_map(function ($paragraph, $index) {
                return $index === 0 ? $paragraph : '    ' . $paragraph;  // Indent all paragraphs after the first
            }, $paragraphs, array_keys($paragraphs));

            // Reconstruct the footnote with proper indentation
            return $matches[1] . implode("\n\n", $indentedParagraphs) . "\n\n";
        }, $cleanedContent);

        Log::info("Combined cleanup completed.");
        return $cleanedContent;
    }
}
