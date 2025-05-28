<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;
use App\Http\Controllers\ConversionController;
use League\CommonMark\CommonMarkConverter;

class TextController extends Controller
{


     public function show(Request $request, $book)
        {
            // true if ?edit=1 OR if this route was named book.edit
            $editMode = $request->boolean('edit')
                     || $request->routeIs('book.edit');

            // 2) Locate your MD / HTML files
            $markdownPath = resource_path("markdown/{$book}/main-text.md");
            $htmlPath     = resource_path("markdown/{$book}/main-text.html");

            $markdownExists = File::exists($markdownPath);
            $htmlExists     = File::exists($htmlPath);

            // NEW: Check if this is an IndexedDB-only book
            if (! $markdownExists && ! $htmlExists) {
                // Instead of immediately aborting, check if it might be an IndexedDB book
                // You can identify IndexedDB books by their naming pattern
                if (str_starts_with($book, 'book_') && is_numeric(substr($book, 5))) {
                    // This looks like an IndexedDB book (book_timestamp format)
                    return view('reader', [
                        'html'     => '', // Empty HTML - will be loaded by JS
                        'book'     => $book,
                        'editMode' => $editMode,
                        'dataSource' => 'indexedDB', // Flag for frontend
                    ]);
                }
                
                // If it doesn't match IndexedDB pattern, it's truly not found
                abort(404, "Book not found");
            }

            // 3) Decide whether to convert MD → HTML (existing logic)
            $convertToHtml = false;
            if ($markdownExists) {
                if (! $htmlExists) {
                    $convertToHtml = true;
                } else {
                    $markdownModified = File::lastModified($markdownPath);
                    $htmlModified     = File::lastModified($htmlPath);
                    if ($markdownModified > $htmlModified) {
                        $convertToHtml = true;
                    }
                }
            }

            // 4) Perform conversion if needed (existing logic)
            if ($convertToHtml) {
                $markdown = File::get($markdownPath);
                $markdown = $this->normalizeMarkdown($markdown);

                // Assuming your ConversionController takes ($book) in ctor
                $conversionController = new ConversionController($book);

                // overwrite the normalized markdown before converting
                File::put($markdownPath, $markdown);

                $html = $conversionController->markdownToHtml();
            } else {
                $html = File::get($htmlPath);
            }

            // 5) Return the view, passing HTML, book ID, and editMode
            return view('reader', [
                'html'     => $html,
                'book'     => $book,
                'editMode' => $editMode,
                'dataSource' => 'backend', // Flag for frontend
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
