<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;

class HighlightController extends Controller
{
    public function store(Request $request)
    {
        // Retrieve necessary inputs from the request
        $textSegment = $request->input('text');
        $highlightId = $request->input('highlight_id');
        $book = $request->input('book');
        $startXPath = $request->input('start_xpath');
        $endXPath = $request->input('end_xpath');
        $xpathFull = $request->input('xpath_full');
        $startPosition = $request->input('start_position');
        $endPosition = $request->input('end_position');
        $updatedHtml = $request->input('updated_html');

        \Log::info("Store function called for book: {$book}, text: {$textSegment}, highlight ID: {$highlightId}");

        // Validate that required XPath values are present
        if (empty($startXPath) || empty($endXPath) || empty($xpathFull)) {
            \Log::error("Invalid or missing XPath values.");
            return response()->json(['success' => false, 'message' => 'Invalid or missing XPath values.'], 400);
        }

        // Validate that updated HTML is provided
        if (empty($updatedHtml)) {
            \Log::error("Updated HTML content not provided.");
            return response()->json(['success' => false, 'message' => 'Updated HTML content not provided.'], 400);
        }

        // Save updated HTML to the file
        $htmlFilePath = resource_path("markdown/{$book}/main-text.html");
        try {
            File::put($htmlFilePath, $updatedHtml);
            \Log::info("Successfully updated HTML file for book: {$book}");
        } catch (\Exception $e) {
            \Log::error("Error saving HTML content: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Error saving HTML content.'], 500);
        }

        // Insert or update highlight data in the database
        DB::table('highlights')->insert([
            'text' => $textSegment,
            'highlight_id' => $highlightId,
            'book' => $book,
            'start_xpath' => $startXPath,
            'end_xpath' => $endXPath,
            'xpath_full' => $xpathFull,
            'start_position' => $startPosition,
            'end_position' => $endPosition,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // Update hyperlights.md after creating a highlight
        $this->updateHyperlightsMd($book);

        return response()->json(['success' => true, 'message' => 'Highlight created/updated successfully.']);
    }

    public function deleteHighlight(Request $request)
    {
        // Log all incoming request data
        \Log::info('Request Data for Deleting Highlight:', [
            'highlight_ids' => $request->input('highlight_ids'),
            'updated_html' => $request->input('updated_html'),
            'book' => $request->input('book')
        ]);

        // Validate the incoming data
        $request->validate([
            'highlight_ids' => 'required|array',  // Ensure highlight_ids is provided as an array
            'updated_html' => 'required|string',  // Ensure updated_html is provided
            'book' => 'required|string',  // Ensure book is provided
        ]);

        $highlightIds = $request->input('highlight_ids');
        $updatedHtml = $request->input('updated_html');
        $book = $request->input('book');

        \Log::info("Highlight IDs to delete: ", $highlightIds);

        // Step 1: Mark the highlights as deleted in the database by updating the deleted_at column
        try {
            DB::table('highlights')
                ->whereIn('highlight_id', $highlightIds)
                ->update(['deleted_at' => now()]);

            \Log::info('Successfully marked highlights as deleted.');
        } catch (\Exception $e) {
            \Log::error("Error updating highlights: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Error deleting highlights.'], 500);
        }

        // Step 2: Update the HTML content on the server
        $htmlFilePath = resource_path("markdown/{$book}/main-text.html");
        try {
            File::put($htmlFilePath, $updatedHtml);  // Save the updated HTML content
            \Log::info("Successfully updated HTML file for book: {$book}");
        } catch (\Exception $e) {
            \Log::error("Error updating HTML content: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Error updating HTML.'], 500);
        }

        // Update hyperlights.md after deleting a highlight
        $this->updateHyperlightsMd($book);

        return response()->json(['success' => true, 'message' => 'Highlights deleted and HTML updated successfully.']);
    }

private function updateHyperlightsMd($book)
{
    // Fetch all non-deleted highlights for the book
    $highlights = DB::table('highlights')
        ->where('book', $book)
        ->whereNull('deleted_at')  // Only get non-deleted highlights
        ->orderBy('start_xpath')   // Order by start_xpath to maintain sequence
        ->orderBy('start_position') // In case of duplicates
        ->get();

    // Prepare markdown content
        $mdContent = '';
    foreach ($highlights as $highlight) {
        // Split the highlight text into paragraphs
        $paragraphs = explode("\n\n", $highlight->text);

        // Start the blockquote with the opening quote for the first paragraph
        $mdContent .= "> \"" . trim($paragraphs[0]) . "\n";

        // Add blockquote (>) for the remaining paragraphs, except the last one
        for ($i = 1; $i < count($paragraphs); $i++) {
            $mdContent .= ">\n> " . trim($paragraphs[$i]) . "\n";
        }

        // Append the closing quote at the end of the last paragraph
        $mdContent = rtrim($mdContent) . "\"";  // Remove trailing newlines before adding the closing quote

        // Add the reference link immediately after the blockquote
        $mdContent .= "\n> [↩](" . url("{$book}#{$highlight->highlight_id}") . ")\n\n";

        // Insert the annotation text from the 'annotations' column, if it exists, after the backlink
        if (!empty($highlight->annotations)) {
            $mdContent .= "\n" . trim($highlight->annotations) . "\n\n";
        }

        // Add three paragraph breaks after each highlight block and a horizontal rule
        $mdContent .= "\n\n\n---\n\n";
    }




    

    // Define the file path for hyperlights.md
    $mdFilePath = resource_path("markdown/{$book}/hyperlights.md");

    // Save the content to hyperlights.md
    File::put($mdFilePath, $mdContent);

    \Log::info("Successfully updated hyperlights.md for book: {$book}");
}



}
