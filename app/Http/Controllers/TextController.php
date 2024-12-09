<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;
use App\Http\Controllers\ConversionController;
use League\CommonMark\CommonMarkConverter;

class TextController extends Controller
{
    // Show the main text or its HTML version for a specific book
    public function show($book)
    {
        // Define paths to the markdown and HTML files based on the folder name
        $markdownPath = resource_path("markdown/{$book}/main-text.md");
        $htmlPath = resource_path("markdown/{$book}/main-text.html");

        // Check if both files exist
        $markdownExists = File::exists($markdownPath);
        $htmlExists = File::exists($htmlPath);

        // If neither file exists, abort with an error
        if (!$markdownExists && !$htmlExists) {
            abort(404, "Book not found");
        }

        // Determine if we need to convert markdown to HTML
        $convertToHtml = false;

        if ($markdownExists) {
            if (!$htmlExists) {
                // HTML does not exist, need to convert
                $convertToHtml = true;
            } else {
                // Both files exist, compare modification times
                $markdownModified = File::lastModified($markdownPath);
                $htmlModified = File::lastModified($htmlPath);

                if ($markdownModified > $htmlModified) {
                    // Markdown is newer, need to convert
                    $convertToHtml = true;
                }
            }
        }

        if ($convertToHtml) {
            // Load the main text markdown file
            $markdown = File::get($markdownPath);

            // Preprocess the markdown to handle soft line breaks
            $markdown = $this->normalizeMarkdown($markdown);

            // Use ConversionController to convert markdown to HTML
            $conversionController = new ConversionController($book);

            // Save the preprocessed markdown back to the file before conversion
            File::put($markdownPath, $markdown);

            // Convert the markdown content to HTML
            $html = $conversionController->markdownToHtml();

            // The markdownToHtml() method saves the HTML file, so we can proceed
        } else {
            // Load the existing HTML file
            $html = File::get($htmlPath);
        }

        // Pass the HTML (either from file or generated) to the view
        return view('reader', [
            'html' => $html,
            'book' => $book,
        ]);
    }

    // Preprocess the markdown to handle soft line breaks
    private function normalizeMarkdown($markdown)
    {
        // Split markdown content by double newlines to preserve block-level elements
        $paragraphs = preg_split('/(\n\s*\n)/', $markdown, -1, PREG_SPLIT_DELIM_CAPTURE);

        // Iterate through each block and normalize only the inner soft line breaks, excluding code blocks, blockquotes, and lists
        foreach ($paragraphs as &$block) {
            // Skip processing if the block is a code block (either fenced or indented)
            if (preg_match('/^( {4}|\t)|(```)/m', $block)) {
                continue;  // Skip normalization for code blocks
            }

            // Skip processing if the block starts with a blockquote or a list item
            if (preg_match('/^\s*>|\d+\.\s|\*\s|-\s|\+\s/m', $block)) {
                continue;  // Skip normalization for blockquotes and lists
            }

            // If the block isn't just a delimiter (double newline), normalize inner soft line breaks
            if (!preg_match('/^\n\s*\n$/', $block)) {
                // Replace single newlines within a paragraph block with spaces
                $block = preg_replace('/(?<!\n)\n(?!\n)/', ' ', $block);
            }
        }

        // Recombine the paragraphs to maintain block structure
        return implode('', $paragraphs);
    }

    // Show the hyperlights content for a specific book
    public function showHyperlights($book)
    {
        // Define the path to the hyperlights markdown file
        $hyperLightsPath = resource_path("markdown/{$book}/hyperlights.md");

        // Check if the hyperlights markdown file exists
        if (!File::exists($hyperLightsPath)) {
            abort(404, "Hyperlights not found for book: $book");
        }

        // Load the hyperlights markdown file
        $markdown = File::get($hyperLightsPath);

        // Use CommonMarkConverter to convert the markdown to HTML
        $converter = new CommonMarkConverter();
        $html = $converter->convertToHtml($markdown);

        // Pass the converted HTML to the Blade template
        return view('hyperlights-md', [
            'html' => $html,
            'book' => $book
        ]);
    }

    public function showHyperlightsHTML($book)
    {
        // Define the path to the HTML file for this book
        $htmlFilePath = resource_path("markdown/{$book}/hyperlights.html");

        // Check if the HTML file exists
        if (!File::exists($htmlFilePath)) {
            abort(404, "Main HTML content not found for book: $book");
        }

        // Load the HTML file content
        $htmlContent = File::get($htmlFilePath);

        // Pass the content to the Blade template
        return view('hyperlights', [
            'htmlContent' => $htmlContent,  // Pass the HTML content
            'book' => $book
        ]);
    }
}
