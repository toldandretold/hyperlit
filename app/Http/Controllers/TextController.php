<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;

class TextController extends Controller
{
    // Show the main text or its HTML version for a specific book
    public function show($book)
    {
        // Define paths to the markdown and HTML files based on the folder name
        $markdownPath = resource_path("markdown/{$book}/main-text.md");
        $htmlPath = resource_path("markdown/{$book}/main-text.html");

        // Check if the HTML version of the file exists
        if (File::exists($htmlPath)) {
            // Load the HTML file directly
            $html = File::get($htmlPath);
        } else {
            // Fallback to markdown conversion if HTML file does not exist

            // Check if the main text markdown file exists
            if (!File::exists($markdownPath)) {
                abort(404, "Book not found");
            }

            // Load the main text markdown file
            $markdown = File::get($markdownPath);

            // Preprocess the markdown to handle soft line breaks
            $markdown = $this->normalizeMarkdown($markdown);

            // Create an instance of MappedParsedown or another Markdown converter
            $converter = new MappedParsedown();
            $converter->setBook($book); // Set the book identifier

            // Convert the markdown content to HTML
            $result = $converter->text($markdown);
            $html = $result['html'];
            $mapping = $result['mapping'];

            // Save the converted HTML for future use
            File::put($htmlPath, $html);

            // Handle text mapping (for highlights, etc.)
            foreach ($mapping as $map) {
                $this->saveMapping($book, $map);
            }
        }

        // Pass the HTML (either from file or generated) to the view
        return view('hyperlightingM', [
            'html' => $html,
            'book' => $book,
        ]);
    }

    // Preprocess the markdown to handle soft line breaks
    private function normalizeMarkdown($markdown)
{
    // Split markdown content by double newlines to preserve block-level elements like headers, paragraphs, and lists
    $paragraphs = preg_split('/(\n\s*\n)/', $markdown, -1, PREG_SPLIT_DELIM_CAPTURE);

    // Iterate through each block and normalize only the inner soft line breaks, excluding code blocks
    foreach ($paragraphs as &$block) {
        // Skip processing if the block is a code block (either fenced or indented)
        if (preg_match('/^( {4}|\t)|(```)/', $block)) {
            continue;  // Skip normalization for code blocks
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

        // Use a Markdown converter to convert the markdown to HTML
        $converter = new \League\CommonMark\CommonMarkConverter();
        $html = $converter->convertToHtml($markdown);

        // Pass the converted HTML to the Blade template
        return view('hyperlights', [
            'html' => $html,
            'book' => $book
        ]);
    }

    // Helper method to save the text mappings for highlights
    private function saveMapping($book, $map)
    {
        $mappingData = [
            'book' => $book,
            'markdown_text' => $map['markdown'],
            'html_text' => $map['html'],
            'start_position_markdown' => $map['start_position_markdown'],
            'end_position_markdown' => $map['end_position_markdown'],
            'start_position_html' => $map['start_position_html'],
            'end_position_html' => $map['end_position_html'],
            'context_hash' => $map['context_hash'],
            'mapping_id' => $map['mapping_id'],
            'xpath' => $map['xpath'],
            'created_at' => now(),
            'updated_at' => now(),
        ];

        // Check for existing mapping
        $existingMapping = DB::table('text_mappings')
            ->where('book', $book)
            ->where('markdown_text', $map['markdown'])
            ->where('start_position_markdown', $map['start_position_markdown'])
            ->where('end_position_markdown', $map['end_position_markdown'])
            ->where('start_position_html', $map['start_position_html'])
            ->where('end_position_html', $map['end_position_html'])
            ->first();

        if ($existingMapping) {
            // Update existing mapping if necessary
            if ($existingMapping->html_text !== $map['html']) {
                DB::table('text_mappings')
                    ->where('id', $existingMapping->id)
                    ->update($mappingData);
            }
        } else {
            // Insert new mapping
            DB::table('text_mappings')->insert($mappingData);
        }
    }
}
