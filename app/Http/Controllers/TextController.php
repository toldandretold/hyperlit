<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;

class TextController extends Controller
{
    public function show($book)
    {
        // Define paths to the markdown files based on the folder name
        $markdownPath = resource_path("markdown/{$book}/main-text.md");
        $hyperLightsPath = resource_path("markdown/{$book}/hyper-lights.md");

        // Check if the main text markdown file exists
        if (!File::exists($markdownPath)) {
            abort(404, "Book not found");
        }

        // Load the main text markdown file
        $markdown = File::get($markdownPath);

        // Create an instance of MappedParsedown
        $converter = new MappedParsedown();

        // Set the book identifier before processing the markdown text
        $converter->setBook($book); // This is critical to avoid exceptions

        // Now process the markdown content
        $result = $converter->text($markdown);

        $html = $result['html'];
        $mapping = $result['mapping'];

        foreach ($mapping as $map) {
            \Log::info("Processing mapping for text: {$map['markdown']}, Start Markdown: {$map['start_position_markdown']}, End Markdown: {$map['end_position_markdown']}, Start HTML: {$map['start_position_html']}, End HTML: {$map['end_position_html']}");

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
                'xpath' => $map['xpath'], // Ensure this is included
                'created_at' => now(),
                'updated_at' => now(),
            ];

            \Log::info("Checking for existing mapping with book: {$book}, text: {$map['markdown']}, start_position_markdown: {$map['start_position_markdown']}, end_position_markdown: {$map['end_position_markdown']}");

            $existingMapping = DB::table('text_mappings')
                ->where('book', $book)
                ->where('markdown_text', $map['markdown'])
                ->where('start_position_markdown', $map['start_position_markdown'])
                ->where('end_position_markdown', $map['end_position_markdown'])
                ->where('start_position_html', $map['start_position_html'])
                ->where('end_position_html', $map['end_position_html'])
                ->first();

            if ($existingMapping) {
                \Log::info("Existing mapping found for ID: {$existingMapping->id}. Checking if update is necessary.");

                if ($existingMapping->html_text !== $map['html']) {
                    \Log::info("Updating mapping ID: {$existingMapping->id} with new HTML.");

                    DB::table('text_mappings')
                        ->where('id', $existingMapping->id)
                        ->update($mappingData);
                }
            } else {
                \Log::info("Inserting new mapping for text: {$map['markdown']}");

                DB::table('text_mappings')->insert($mappingData);
            }
        }

        return view('hyperlightingM', [
            'html' => $html,
            'book' => $book,
            'hyperLightsPath' => $hyperLightsPath,
            'mapping' => $mapping,
        ]);
    }
}
