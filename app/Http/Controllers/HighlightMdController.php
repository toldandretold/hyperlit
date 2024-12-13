<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;
use App\Http\Controllers\ConversionController;
use League\HTMLToMarkdown\HtmlConverter;

class HighlightMdController extends Controller
{
    public function store(Request $request)
{
    // Retrieve necessary inputs from the request
    $book = $request->input('book');
    $blocks = $request->input('blocks'); // Array of blocks with 'id' and 'html'
    $highlightId = $request->input('highlight_id'); // Retrieve highlight_id from the request
    $textSegment = $request->input('text');
    $startXPath = $request->input('start_xpath');
    $endXPath = $request->input('end_xpath');
    $xpathFull = $request->input('xpath_full');
    $startPosition = $request->input('start_position');
    $endPosition = $request->input('end_position');

    \Log::info("Store function called for book: {$book}, text: {$textSegment}");
    \Log::info("Blocks received: " . json_encode($blocks));

    // Validate that required fields are present
    if (empty($blocks) || empty($highlightId) || empty($book)) {
        \Log::error("Invalid or missing data.");
        return response()->json(['success' => false, 'message' => 'Invalid or missing data.'], 400);
    }

    // Step 1: Insert highlight data into the database
    try {
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
        \Log::info("Successfully inserted highlight data into database.");
    } catch (\Exception $e) {
        \Log::error("Error inserting highlight data into the database: " . $e->getMessage());
        return response()->json(['success' => false, 'message' => 'Error inserting highlight data into the database.'], 500);
    }

    // Step 2: Update the relevant lines in the Markdown file
    $markdownFilePath = resource_path("markdown/{$book}/main-text.md");

    try {
    $markdownLines = file($markdownFilePath); // Read Markdown file into an array

    foreach ($blocks as $block) {
        $blockId = (int)$block['id'];
        $blockHtml = $block['html'];

        \Log::info("Original HTML for block {$blockId}: {$blockHtml}");

        // Convert HTML to Markdown
        $processedMarkdown = $this->convertHtmlToMarkdown($blockHtml);
        \Log::info("Processed Markdown for block {$blockId}: {$processedMarkdown}");

        if (isset($markdownLines[$blockId - 1])) {
            \Log::info("Updating line {$blockId}: {$markdownLines[$blockId - 1]}");
            $markdownLines[$blockId - 1] = $processedMarkdown . PHP_EOL;
        } else {
            \Log::warning("Block ID {$blockId} not found in Markdown file.");
        }
    }

    file_put_contents($markdownFilePath, implode('', $markdownLines));
    \Log::info("Successfully updated Markdown file for book: {$book}");
} catch (\Exception $e) {
    \Log::error("Error updating Markdown file: " . $e->getMessage());
    return response()->json(['success' => false, 'message' => 'Error updating Markdown file.'], 500);
}


    // Step 3: Update hyperlights and global positions as before
    try {
        $conversionController = new ConversionController($book);
        $conversionController->updateGlobalPositions($book);
        $this->updateHyperlightsMd($book);
        $this->updateHyperlightsHtml($book);
        \Log::info("Successfully updated hyperlights and global positions for book: {$book}");
    } catch (\Exception $e) {
        \Log::error("Error updating hyperlights or global positions: " . $e->getMessage());
        return response()->json(['success' => false, 'message' => 'Error updating hyperlights or global positions.'], 500);
    }

    return response()->json(['success' => true, 'message' => 'Highlight created/updated successfully.']);
}

// Helper function to convert HTML to Markdown
private function convertHtmlToMarkdown($html)
{
    // Wrap the HTML in a dummy <div> to prevent DOMDocument from adding <html><body>
    $html = '<div>' . $html . '</div>';

    // Load the HTML into DOMDocument
    $doc = new \DOMDocument();
    @$doc->loadHTML(mb_convert_encoding($html, 'HTML-ENTITIES', 'UTF-8'));

    $markdownContent = '';

    // Process the child nodes of the dummy <div>
    foreach ($doc->getElementsByTagName('div')->item(0)->childNodes as $node) {
        if ($node->nodeType === XML_TEXT_NODE) {
            // Append plain text directly
            $markdownContent .= htmlspecialchars($node->nodeValue, ENT_QUOTES | ENT_HTML5);
        } elseif ($node->nodeType === XML_ELEMENT_NODE) {
            // Preserve inline and block-level HTML
            $markdownContent .= $doc->saveHTML($node);
        }
    }

    // Return the processed Markdown content
    return trim($markdownContent);
}

    public function deleteHighlight(Request $request)
{
    \Log::info('Request Data for Deleting Highlight:', [
        'highlight_ids' => $request->input('highlight_ids'),
        'block_ids' => $request->input('block_ids'), // Receive block IDs from the frontend
        'book' => $request->input('book')
    ]);

    // Validate the incoming data
    $request->validate([
        'highlight_ids' => 'required|array',  // Ensure highlight_ids is provided as an array
        'block_ids' => 'required|array',     // Ensure block_ids is provided as an array
        'book' => 'required|string',         // Ensure book is provided
    ]);

    $highlightIds = $request->input('highlight_ids');
    $blockIds = $request->input('block_ids');
    $book = $request->input('book');

    \Log::info("Highlight IDs to delete: ", $highlightIds);
    \Log::info("Block IDs to process: ", $blockIds);

    // Step 1: Mark the highlights as deleted in the database
    try {
        DB::table('highlights')
            ->whereIn('highlight_id', $highlightIds)
            ->update(['deleted_at' => now()]);

        \Log::info('Successfully marked highlights as deleted.');
    } catch (\Exception $e) {
        \Log::error("Error updating highlights: " . $e->getMessage());
        return response()->json(['success' => false, 'message' => 'Error deleting highlights.'], 500);
    }

    // Step 2: Update the relevant lines in the Markdown file
    $markdownFilePath = resource_path("markdown/{$book}/main-text.md");

    try {
        $markdownLines = file($markdownFilePath); // Read the Markdown file into an array

        foreach ($blockIds as $blockId) {
            $lineIndex = (int)$blockId - 1; // Convert block ID to line index (1-based to 0-based)

            if (isset($markdownLines[$lineIndex])) {
                \Log::info("Processing line {$lineIndex}: {$markdownLines[$lineIndex]}");

                // Remove any `mark` tags containing the highlight IDs
                foreach ($highlightIds as $highlightId) {
                    $markdownLines[$lineIndex] = preg_replace(
                        "/<mark[^>]*class=[\"']?{$highlightId}[\"']?[^>]*>(.*?)<\/mark>/i",
                        "$1",
                        $markdownLines[$lineIndex]
                    );
                }

                \Log::info("Updated line {$lineIndex}: {$markdownLines[$lineIndex]}");
            } else {
                \Log::warning("Block ID {$blockId} not found in Markdown file.");
            }
        }

        // Save the updated Markdown content back to the file
        file_put_contents($markdownFilePath, implode('', $markdownLines));
        \Log::info("Successfully updated Markdown file for book: {$book}");
    } catch (\Exception $e) {
        \Log::error("Error updating Markdown file: " . $e->getMessage());
        return response()->json(['success' => false, 'message' => 'Error updating Markdown file.'], 500);
    }


        // Update hyperlights.md and hyperlights.html after deleting a highlight
        $this->updateHyperlightsMd($book);
        $this->updateHyperlightsHtml($book);

        return response()->json(['success' => true, 'message' => 'Highlights deleted and HTML updated successfully.']);
    }

    // Update hyperlights.md with non-deleted highlights

    private function updateHyperlightsMd($book)
    {
        $highlights = DB::table('highlights')
            ->where('book', $book)
            ->whereNull('deleted_at')  // Only get non-deleted highlights
            ->orderBy('global_position') // Order by global position
            ->get();

        // Create an instance of the HTML to Markdown converter
        $converter = new HtmlConverter();

        $mdContent = '';
        foreach ($highlights as $highlight) {
            $paragraphs = explode("\n\n", $highlight->text);
            $mdContent .= "> \"" . trim($paragraphs[0]) . "\n";

            for ($i = 1; $i < count($paragraphs); $i++) {
                $mdContent .= ">\n> " . trim($paragraphs[$i]) . "\n";
            }

            $mdContent = rtrim($mdContent) . "\"";  
            $mdContent .= "\n> [↩](" . url("{$book}#{$highlight->highlight_id}") . ")\n\n";

            if (!empty($highlight->annotations)) {
                // Convert the HTML annotation to Markdown
                $markdownAnnotation = $converter->convert($highlight->annotations);
                $mdContent .= "\n" . trim($markdownAnnotation) . "\n\n";
            }

            $mdContent .= "\n\n---\n\n";
        }

        $mdFilePath = resource_path("markdown/{$book}/hyperlights.md");

        if (!File::exists($mdFilePath)) {
            File::put($mdFilePath, '');
            \Log::info("Created hyperlights.md for book: {$book}");
        }

        File::put($mdFilePath, $mdContent);
        \Log::info("Successfully updated hyperlights.md for book: {$book}");
    }


    // Update hyperlights.html with non-deleted highlights
    private function updateHyperlightsHtml($book)
    {
        $highlights = DB::table('highlights')
            ->where('book', $book)
            ->whereNull('deleted_at')  
            ->orderBy('global_position') // Order by global position
            ->get();

        $htmlContent = '';
        foreach ($highlights as $highlight) {
            // Create a blockquote with highlight text
            $htmlContent .= "<blockquote id=\"{$highlight->highlight_id}\">\n";
            $paragraphs = explode("\n\n", $highlight->text);

            foreach ($paragraphs as $paragraph) {
                $htmlContent .= "<p>\"" . htmlspecialchars(trim($paragraph)) . "\"</p>\n"; // Leave text escaped
            }

            // Add link to the highlight
            $htmlContent .= "<a href='" . url("{$book}#{$highlight->highlight_id}") . "'>↩</a>\n";
            $htmlContent .= "</blockquote>\n";

            // Render annotations without escaping HTML
            if (!empty($highlight->annotations)) {
                $htmlContent .= "<div id='{$highlight->highlight_id}' class='annotation' contenteditable='true'>";
                $htmlContent .= "<p>" . $highlight->annotations . "</p>\n";  // Do not use htmlspecialchars() here
                $htmlContent .= "</div>\n";
            } else {
                $htmlContent .= "<div id='{$highlight->highlight_id}' class='annotation' contenteditable='true'><p>&nbsp;</p></div>\n";
            }

            // Add a line break after each block
            $htmlContent .= "<hr>\n";
        }

        $htmlFilePath = resource_path("markdown/{$book}/hyperlights.html");

        // Ensure the file exists or create a new one
        if (!File::exists($htmlFilePath)) {
            File::put($htmlFilePath, '');
            \Log::info("Created hyperlights.html for book: {$book}");
        }

        // Save the HTML content to the file
        File::put($htmlFilePath, $htmlContent);
        \Log::info("Successfully updated hyperlights.html for book: {$book}");
    }



    public function updateAnnotations(Request $request, $book)
    {
        // Get the annotations array from the request
        $annotations = $request->input('annotations');
        $htmlContent = $request->input('htmlContent');  // Also get the HTML content

        \Log::info('Updating annotations and HTML content for book: ' . $book);

            // Define the correct path for hyperlights.html and hyperlights.md
        $htmlFilePath = resource_path("markdown/{$book}/hyperlights.html");  // Add this line
        $mdFilePath = resource_path("markdown/{$book}/hyperlights.md");      // Ensure this is defined

        try {
            // Loop through each annotation and update the respective highlight entry
            foreach ($annotations as $annotationData) {
                $highlightId = $annotationData['highlight_id'];
                $annotationText = $annotationData['annotation'];

                // Set annotation to null if it's empty
                if (empty(trim($annotationText))) {
                    $annotationText = null;
                }

                // Update the annotation in the highlights table where the highlight_id and book match
                DB::table('highlights')
                    ->where('highlight_id', $highlightId)
                    ->where('book', $book)
                    ->update([
                        'annotations' => $annotationText,
                        'updated_at' => now()
                    ]);
            }

                    // Update the markdown file
            $this->updateHyperlightsHtml($book);
            $this->updateHyperlightsMd($book);
            



            if (!empty($htmlContent)) {
                File::put($htmlFilePath, $htmlContent);
                \Log::info("Successfully updated HTML file for book: {$book}");
            }

            // Return success response
            return response()->json(['success' => true, 'message' => 'Annotations and HTML content updated successfully.']);

        } catch (\Exception $e) {
            \Log::error("Error updating annotations or HTML content: " . $e->getMessage());

            // Return error response
            return response()->json(['success' => false, 'message' => 'Error updating annotations or HTML content.'], 500);
        }
    }

    public function markHighlightsAsDeleted(Request $request, $book)
    {
        \Log::info('Received request to mark highlights as deleted for book: ' . $book);

        // Get the highlight_ids array from the request
        $highlightIds = $request->input('deleted_highlights');

        // Check if highlight_ids are provided and ensure it's an array
        if (empty($highlightIds) || !is_array($highlightIds)) {
            return response()->json(['success' => false, 'message' => 'No highlight IDs provided or invalid format.'], 400);
        }

        \Log::info("Highlight IDs to delete (array):", $highlightIds);  // Log the array to verify its structure

        // Step 1: Mark the highlights as deleted in the database
        try {
            DB::table('highlights')
                ->where('book', $book)
                ->whereIn('highlight_id', array_column($highlightIds, 'highlight_id'))  // Extract IDs
                ->update(['deleted_at' => now()]);

            \Log::info("Successfully marked highlights as deleted: " . implode(", ", array_column($highlightIds, 'highlight_id')));

        } catch (\Exception $e) {
            \Log::error("Error marking highlights as deleted: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Error marking highlights as deleted.'], 500);
        }

        // Step 2: Find and remove <mark> tags with deleted highlights from main-text.html
        $htmlFilePath = resource_path("markdown/{$book}/main-text.html");
        
        if (File::exists($htmlFilePath)) {
            try {
                $htmlContent = File::get($htmlFilePath);

                // Load the HTML content into a DOMDocument
                $dom = new \DOMDocument();
                @$dom->loadHTML($htmlContent, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD); // Suppress warnings

                // Get all <mark> elements in the document
                $xpath = new \DOMXPath($dom);

                // Query the database for highlights that have been marked as deleted
                $deletedHighlights = DB::table('highlights')
                    ->where('book', $book)
                    ->whereNotNull('deleted_at')
                    ->pluck('highlight_id');

                foreach ($deletedHighlights as $highlightId) {
                    // Search for <mark> elements with the class "highlight_id"
                    $nodesToDelete = $xpath->query("//mark[contains(@class, '{$highlightId}')]");
                    foreach ($nodesToDelete as $node) {
                        $node->parentNode->removeChild($node);  // Remove the <mark> node
                    }
                }

                // Save the updated HTML content back to the file
                File::put($htmlFilePath, $dom->saveHTML());

                \Log::info("Successfully updated main-text.html for book: {$book} to remove deleted highlights.");

            } catch (\Exception $e) {
                \Log::error("Error processing HTML file: " . $e->getMessage());
                return response()->json(['success' => false, 'message' => 'Error updating HTML file.'], 500);
            }
        } else {
            \Log::error("HTML file not found: " . $htmlFilePath);
            return response()->json(['success' => false, 'message' => 'HTML file not found.'], 404);
        }

        // Step 3: Update hyperlights.md and hyperlights.html to reflect only non-deleted highlights
        try {
            $this->updateHyperlightsMd($book);
            $this->updateHyperlightsHtml($book);
            \Log::info("Successfully updated hyperlights files for book: {$book} after deletion.");

            return response()->json(['success' => true, 'message' => 'Highlights marked as deleted and HTML updated successfully.']);

        } catch (\Exception $e) {
            \Log::error("Error updating hyperlights files: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Error updating hyperlights files after deletion.'], 500);
        }
    }


}
