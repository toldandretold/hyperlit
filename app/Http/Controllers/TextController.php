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

       

        $editMode = $request->boolean('edit') || $request->routeIs('book.edit');

        // Check all possible data sources
        $bookExistsInDB = DB::table('node_chunks')->where('book', $book)->exists();
        $markdownPath = resource_path("markdown/{$book}/main-text.md");
        $htmlPath = resource_path("markdown/{$book}/main-text.html");
        $markdownExists = File::exists($markdownPath);
        $htmlExists = File::exists($htmlPath);

        // Determine data source priority and handle accordingly
        if ($bookExistsInDB) {
            // PostgreSQL has the data - serve empty HTML, let JS load from DB
            return view('reader', [
                'html' => '',
                'book' => $book,
                'editMode' => $editMode,
                'dataSource' => 'database',
                'pageType' => 'reader' // <-- ADD THIS
            ]);
        }
        
        if ($markdownExists || $htmlExists) {
            // File system has the data - process files as before
            $convertToHtml = false;
            if ($markdownExists) {
                if (!$htmlExists) {
                    $convertToHtml = true;
                } else {
                    $markdownModified = File::lastModified($markdownPath);
                    $htmlModified = File::lastModified($htmlPath);
                    if ($markdownModified > $htmlModified) {
                        $convertToHtml = true;
                    }
                }
            }

            if ($convertToHtml) {
                $markdown = File::get($markdownPath);
                $markdown = $this->normalizeMarkdown($markdown);
                $conversionController = new ConversionController($book);
                File::put($markdownPath, $markdown);
                $html = $conversionController->markdownToHtml();
            } else {
                $html = File::get($htmlPath);
            }

            return view('reader', [
                'html' => $html,
                'book' => $book,
                'editMode' => $editMode,
                'dataSource' => 'filesystem',
                'pageType' => 'reader' // <-- ADD THIS
            ]);
        }

        // Neither PostgreSQL nor filesystem has it - assume it might be in IndexedDB
        // Always serve the reader view and let frontend JS check IndexedDB
        return view('reader', [
            'html' => '',
            'book' => $book,
            'editMode' => $editMode,
            'dataSource' => 'indexeddb', // Frontend will check IndexedDB
            'pageType' => 'reader' // <-- ADD THIS
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
