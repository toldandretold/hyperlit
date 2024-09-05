<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;
use App\Models\Highlight;
use App\Http\Controllers\HtmlContentExtractor;

class HighlightController extends Controller
{
    public function store(Request $request)
    {
        $textSegment = $request->input('text');
        $hash = $request->input('hash');
        $book = $request->input('book');
        $contextHash = $request->input('context_hash');
        $startPosition = $request->input('start_position');
        $endPosition = $request->input('end_position');

        \Log::info("Store function called for book: {$book}, text: {$textSegment}, start position: {$startPosition}, end position: {$endPosition}");

        // Get the XPath positions for the highlighted text
        $startXPath = $request->input('start_xpath');
        $endXPath = $request->input('end_xpath');

        // Validate XPath values
        if (empty($startXPath) || empty($endXPath)) {
            \Log::error("Invalid or missing XPath values.");
            return response()->json(['success' => false, 'message' => 'Invalid or missing XPath values.'], 400);
        }

        \Log::info("Start XPath: {$startXPath}, End XPath: {$endXPath}");

        // Extract the relevant HTML content using the XPath positions
        try {
            $actualHtmlContent = HtmlContentExtractor::extractHtmlContentFromXPath($book, $startXPath, $endXPath);
        } catch (\Exception $e) {
            \Log::error("Error extracting HTML content: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Error extracting HTML content.'], 500);
        }

        \Log::info("Actual HTML content retrieved: {$actualHtmlContent}");

        // Log additional information for debugging occurrence search
        \Log::info("Attempting to find correct occurrence for text: {$textSegment} within HTML content: {$actualHtmlContent}");

        // Find the correct occurrence of the text within the XPath
        $correctOccurrenceIndex = $this->findCorrectOccurrenceInHtml($actualHtmlContent, $textSegment, $startPosition, $endPosition);

        if ($correctOccurrenceIndex === -1) {
            \Log::error("Correct occurrence of the highlighted text not found. Text: '{$textSegment}', Start XPath: {$startXPath}, End XPath: {$endXPath}");
            return response()->json(['success' => false, 'message' => 'Correct occurrence of the highlighted text not found.'], 400);
        }

        \Log::info("Correct occurrence index: {$correctOccurrenceIndex}");

        // Get the original markdown
        $originalMarkdown = $this->getOriginalMarkdown($book);

        // Use text_mappings to find the corresponding markdown positions
        $markdownPosition = $this->findMarkdownPositionFromXPath($book, $textSegment, $startXPath, $correctOccurrenceIndex);

        if ($markdownPosition === false) {
            \Log::error("Could not find the correct instance of the highlighted text in Markdown for text: {$textSegment}");
            return response()->json(['success' => false, 'message' => 'Could not find the correct instance of the highlighted text in Markdown.'], 400);
        }

        \Log::info("Markdown position found: {$markdownPosition}");

        // Insert the highlight tags in the Markdown file
        $updatedMarkdown = substr_replace(
            $originalMarkdown,
            "<mark><a href=\"/hyper-lights#{$hash}\" id=\"{$hash}\">{$textSegment}</a></mark>",
            $markdownPosition,
            strlen($textSegment)
        );

        // Save the updated markdown back to the file
        $filePath = resource_path("markdown/{$book}/main-text.md");
        File::put($filePath, $updatedMarkdown);

        \Log::info("Successfully updated markdown at position: {$markdownPosition}");

        // Save highlight to highlights table with start and end positions and XPath
        DB::table('highlights')->insert([
            'text' => $textSegment,
            'highlight_id' => $hash,   // Changed from 'hash' to 'highlight_id'
            'book' => $book,
            'context_hash' => $contextHash,
            'start_xpath' => $startXPath,
            'end_xpath' => $endXPath,
            'start_position' => $startPosition,  // Record start position
            'end_position' => $endPosition,  // Record end position
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        \Log::info("Highlight saved to database for hash: {$hash}");

        return response()->json(['success' => true]);
    }

    private function findCorrectOccurrenceInHtml($htmlContent, $textSegment, $startPosition, $endPosition)
    {
        // Logging HTML content and positions for better debugging
        \Log::info("Searching for correct occurrence of '{$textSegment}' between start position: {$startPosition} and end position: {$endPosition} in HTML content: '{$htmlContent}'");

        // Logic to find the correct occurrence of the highlighted text using start and end positions in the HTML
        $currentPosition = 0;
        $occurrenceIndex = 0;

        while (($currentPosition = strpos($htmlContent, $textSegment, $currentPosition)) !== false) {
            \Log::info("Found occurrence of '{$textSegment}' at position: {$currentPosition} in HTML content.");
            // Check if this occurrence's position matches the range (startPosition, endPosition)
            if ($currentPosition >= $startPosition && ($currentPosition + strlen($textSegment)) <= $endPosition) {
                \Log::info("Correct occurrence found at position: {$currentPosition} (index {$occurrenceIndex})");
                return $occurrenceIndex;
            }
            $occurrenceIndex++;
            $currentPosition += strlen($textSegment);
        }

        \Log::error("Correct occurrence not found for text: '{$textSegment}' within the specified range in HTML content.");
        return -1; // If the correct occurrence was not found
    }

    private function findMarkdownPositionFromXPath($book, $textSegment, $startXPath, $correctOccurrenceIndex)
    {
        // Retrieve the text_mappings for the given book and XPath
        $mapping = DB::table('text_mappings')
            ->where('book', $book)
            ->where('xpath', $startXPath)
            ->first();

        if ($mapping) {
            $startMarkdownPosition = $mapping->start_position_markdown;
            $endMarkdownPosition = $mapping->end_position_markdown;

            \Log::info("Mapping found: Start Markdown Position: {$startMarkdownPosition}, End Markdown Position: {$endMarkdownPosition}");

            // Ensure the correct occurrence is found within this range
            $currentPosition = $startMarkdownPosition;
            $occurrenceInMarkdown = 0;

            // Search within the markdown from the mapped start position
            $originalMarkdown = $this->getOriginalMarkdown($book);
            while (($currentPosition = strpos($originalMarkdown, $textSegment, $currentPosition)) !== false) {
                \Log::info("Found occurrence of '{$textSegment}' at markdown position: {$currentPosition}");
                if ($occurrenceInMarkdown === $correctOccurrenceIndex) {
                    \Log::info("Correct markdown occurrence found at position: {$currentPosition}");
                    return $currentPosition;
                }
                $occurrenceInMarkdown++;
                $currentPosition += strlen($textSegment);
            }
        }

        \Log::error("No mapping found for XPath: {$startXPath} or occurrence not found in markdown.");
        return false; // If the correct position was not found
    }

    private function getOriginalMarkdown($book)
    {
        // Construct the file path to the Markdown file
        $filePath = resource_path("markdown/{$book}/main-text.md");

        // Check if the file exists
        if (!File::exists($filePath)) {
            \Log::error("Markdown file not found for book: {$book}");
            throw new \Exception("Markdown file not found for book: {$book}");
        }

        // Retrieve the content of the Markdown file
        return File::get($filePath);
    }
}
