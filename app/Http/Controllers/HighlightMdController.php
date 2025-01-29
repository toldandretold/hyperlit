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
        $highlightId = $request->input('highlight_id');
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
            $markdownLines = file($markdownFilePath, FILE_IGNORE_NEW_LINES);

            foreach ($blocks as $block) {
                $blockId = $block['id'];
                $blockHtml = $block['html'];

                \Log::info("Original HTML for block {$blockId}: {$blockHtml}");

                if (str_contains($blockHtml, '<blockquote')) {
                    $processedMarkdown = $this->convertBlockquoteToMarkdown($blockHtml);
                    [$startLine, $endLine] = $this->getBlockquoteLineRange($blockId, $blockHtml);

                    array_splice(
                        $markdownLines,
                        $startLine - 1,
                        ($endLine - $startLine) + 1,
                        explode("\n", $processedMarkdown)
                    );
                } else {
                    $processedMarkdown = $this->convertHtmlToMarkdown($blockHtml);
                    $lineNumber = (int)$blockId;

                    if (isset($markdownLines[$lineNumber - 1])) {
                        $currentLine = $markdownLines[$lineNumber - 1];
                        $isBlockquote = str_starts_with(trim($currentLine), '>');
                        $updatedLine = $isBlockquote ? ' > ' . ltrim($processedMarkdown) : rtrim($processedMarkdown);
                        \Log::info("Updating line {$lineNumber}: Original line: '{$currentLine}' Updated line: '{$updatedLine}'");
                        $markdownLines[$lineNumber - 1] = $updatedLine;
                    } else {
                        \Log::warning("Line number {$lineNumber} not found in Markdown file.");
                    }
                }
            }

            file_put_contents($markdownFilePath, implode(PHP_EOL, $markdownLines) . PHP_EOL);
            \Log::info("Successfully updated Markdown file for book: {$book}");
        } catch (\Exception $e) {
            \Log::error("Error updating Markdown file: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Error updating Markdown file.'], 500);
        }

        // Step 3: Update hyperlights and global positions
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


    private function convertBlockquoteToMarkdown($html)
    {
        $doc = new \DOMDocument();
        @$doc->loadHTML(mb_convert_encoding($html, 'HTML-ENTITIES', 'UTF-8'));

        $markdownContent = '';

        // Log the input HTML
        \Log::info("Starting blockquote conversion. Input HTML: " . $html);

        // Process each <blockquote> tag
        foreach ($doc->getElementsByTagName('blockquote') as $blockquote) {
            foreach ($blockquote->getElementsByTagName('p') as $p) {
                // Extract inner HTML of the <p> tag
                $innerHTML = '';
                foreach ($p->childNodes as $child) {
                    $childHTML = trim($doc->saveHTML($child)); // Process child nodes only
                    $innerHTML .= $childHTML;

                    // Log child node HTML
                    \Log::info("Processed child HTML: " . $childHTML);
                }

                // Trim the combined inner HTML
                $innerHTML = trim($innerHTML);

                // Log the content before adding the blockquote marker
                \Log::info("Constructed inner HTML for paragraph: " . $innerHTML);

                // Add the blockquote marker explicitly
                $line = '> ' . $innerHTML . "\n";
                $markdownContent .= $line;

                // Log the constructed Markdown line
                \Log::info("Constructed Markdown line: " . $line);
            }
        }

        // Log the final Markdown content
        \Log::info("Final Markdown content after blockquote conversion: " . $markdownContent);

        return trim($markdownContent);
    }


    private function getBlockquoteLineRange($blockId, $markdownLines)
    {
        $startLine = (int)$blockId; // Start from the given block ID
        $endLine = $startLine;

        if (!isset($markdownLines[$startLine - 1])) {
            \Log::warning("Blockquote start line {$startLine} not found in Markdown file.");
            return [$startLine, $startLine];
        }

        // Ensure the starting line is part of a blockquote
        if (!str_starts_with(trim($markdownLines[$startLine - 1]), '>')) {
            \Log::info("Line {$startLine} is not a blockquote. Treating as single line.");
            return [$startLine, $startLine];
        }

        // Find the start of the blockquote
        for ($i = $startLine - 2; $i >= 0; $i--) {
            if (str_starts_with(trim($markdownLines[$i]), '>')) {
                $startLine = $i + 1;
            } else {
                break;
            }
        }

        // Find the end of the blockquote
        for ($i = $startLine - 1; $i < count($markdownLines); $i++) {
            if (str_starts_with(trim($markdownLines[$i]), '>')) {
                $endLine = $i + 1;
            } else {
                break;
            }
        }

        \Log::info("Determined blockquote range: Start {$startLine}, End {$endLine}");
        return [$startLine, $endLine];
    }







    // Helper function to convert HTML to Markdown
    private function convertHtmlToMarkdown($html)
    {
            try {
                \Log::info("Converting HTML to Markdown: " . $html);

                $html = '<div>' . $html . '</div>';
                $doc = new \DOMDocument();
                @$doc->loadHTML(mb_convert_encoding($html, 'HTML-ENTITIES', 'UTF-8'));

                $markdownContent = '';

                foreach ($doc->getElementsByTagName('div')->item(0)->childNodes as $node) {
                    if ($node->nodeType === XML_TEXT_NODE) {
                        $markdownContent .= $node->nodeValue;
                    } elseif ($node->nodeType === XML_ELEMENT_NODE) {
                        if (in_array($node->nodeName, ['b', 'strong'])) {
                            $markdownContent .= "**" . $node->textContent . "**";
                        } elseif (in_array($node->nodeName, ['i', 'em'])) {
                            $markdownContent .= "*" . $node->textContent . "*";
                        } elseif ($node->nodeName === 'a') {
                            $markdownContent .= $this->preserveElementWithAttributes($node);
                        } elseif ($node->nodeName === 'mark') {
                            $markdownContent .= $this->preserveElementWithAttributes($node);
                        } elseif ($node->nodeName === 'p') {
                            $markdownContent .= "\n\n" . $this->processInlineElements($node) . "\n\n";
                        } else {
                            $markdownContent .= $node->textContent;
                        }
                    }
                }

                return trim($markdownContent);
            } catch (\Exception $e) {
                \Log::error("Error in Markdown conversion: " . $e->getMessage());
                return '';
            }
    }

    private function preserveElementWithAttributes($node)
    {
        $tag = $node->nodeName;
        $attributes = '';
        foreach ($node->attributes as $attr) {
            $attributes .= " {$attr->name}='" . htmlspecialchars($attr->value) . "'";
        }
        return "<{$tag}{$attributes}>" . $node->textContent . "</{$tag}>";
    }

    private function processInlineElements($node)
    {
        $content = '';
        foreach ($node->childNodes as $child) {
            if ($child->nodeType === XML_TEXT_NODE) {
                $content .= $child->nodeValue;
            } elseif ($child->nodeType === XML_ELEMENT_NODE) {
                if (in_array($child->nodeName, ['b', 'strong'])) {
                    $content .= "**" . $child->textContent . "**";
                } elseif (in_array($child->nodeName, ['i', 'em'])) {
                    $content .= "*" . $child->textContent . "*";
                } elseif ($child->nodeName === 'a') {
                    $content .= $this->preserveElementWithAttributes($child);
                } elseif ($child->nodeName === 'mark') {
                    $content .= $this->preserveElementWithAttributes($child);
                } else {
                    $content .= $child->textContent;
                }
            }
        }
        return trim($content);
    }


    public function deleteHighlight(Request $request)
    {
        \Log::info('Request Data for Deleting Highlight:', [
            'highlight_ids' => $request->input('highlight_ids'),
            'block_ids' => $request->input('block_ids'),
            'book' => $request->input('book'),
        ]);

        // Validate incoming request
        $request->validate([
            'highlight_ids' => 'required|array',
            'block_ids' => 'required|array',
            'book' => 'required|string',
        ]);

        $highlightIds = $request->input('highlight_ids');
        $blockIds = $request->input('block_ids');
        $book = $request->input('book');

        \Log::info("Highlight IDs to delete: " . json_encode($highlightIds));
        \Log::info("Block IDs to process: " . json_encode($blockIds));

        $markdownFilePath = resource_path("markdown/{$book}/main-text.md");

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

        // Step 2: Remove highlights from the Markdown file
        try {
            $markdownLines = file($markdownFilePath, FILE_IGNORE_NEW_LINES);

            foreach ($blockIds as $blockId) {
                [$startLine, $endLine] = $this->getBlockquoteLineRange($blockId, $markdownLines);

                \Log::info("Deleting highlights in blockquote lines {$startLine}-{$endLine}");

                for ($lineIndex = $startLine - 1; $lineIndex < $endLine; $lineIndex++) {
                    if (isset($markdownLines[$lineIndex])) {
                        \Log::info("Processing line {$lineIndex}: {$markdownLines[$lineIndex]}");

                        foreach ($highlightIds as $highlightId) {
                            $markdownLines[$lineIndex] = preg_replace(
                                "/<mark[^>]*class=[\"']?{$highlightId}[\"']?[^>]*>(.*?)<\/mark>/is",
                                "$1",
                                $markdownLines[$lineIndex]
                            );
                        }

                        \Log::info("Updated line {$lineIndex}: {$markdownLines[$lineIndex]}");
                    }
                }
            }

            file_put_contents($markdownFilePath, implode(PHP_EOL, $markdownLines) . PHP_EOL);
            \Log::info("Successfully updated Markdown file for book: {$book}");
        } catch (\Exception $e) {
            \Log::error("Error updating Markdown file: " . $e->getMessage());
            return response()->json(['success' => false, 'message' => 'Error updating Markdown file.'], 500);
        }

        // Step 3: Trigger additional updates
        $this->updateHyperlightsMd($book);
        $this->updateHyperlightsHtml($book);

        return response()->json(['success' => true, 'message' => 'Highlights deleted and database updated successfully.']);
    }


        

    /**
     * Check if a block ID corresponds to a blockquote.
     */
    private function isBlockquote($blockId, $markdownLines)
    {
        $lineIndex = (int)$blockId - 1;
        return isset($markdownLines[$lineIndex]) && str_starts_with(trim($markdownLines[$lineIndex]), '>');
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

            \Log::info("Highlight IDs to delete (array):", $highlightIds); // Log the array to verify its structure

            // Step 1: Mark the highlights as deleted in the database
            try {
                DB::table('highlights')
                    ->where('book', $book)
                    ->whereIn('highlight_id', array_column($highlightIds, 'highlight_id')) // Extract IDs
                    ->update(['deleted_at' => now()]);

                \Log::info("Successfully marked highlights as deleted: " . implode(", ", array_column($highlightIds, 'highlight_id')));
            } catch (\Exception $e) {
                \Log::error("Error marking highlights as deleted: " . $e->getMessage());
                return response()->json(['success' => false, 'message' => 'Error marking highlights as deleted.'], 500);
            }

            // Step 2: Remove <mark> tags with deleted highlights from main-text.md
            $markdownFilePath = resource_path("markdown/{$book}/main-text.md");

            if (File::exists($markdownFilePath)) {
                try {
                    $markdownContent = File::get($markdownFilePath);

                    // Query the database for highlights that have been marked as deleted
                    $deletedHighlights = DB::table('highlights')
                        ->where('book', $book)
                        ->whereNotNull('deleted_at')
                        ->pluck('highlight_id');

                    // Iterate through the deleted highlight IDs and remove corresponding <mark> tags
                    foreach ($deletedHighlights as $highlightId) {
                        $pattern = '/<mark[^>]*class=["\']?[^"\'>]*' . preg_quote($highlightId, '/') . '[^"\'>]*["\']?[^>]*>.*?<\/mark>/s';
                        $markdownContent = preg_replace($pattern, '', $markdownContent);
                    }

                    // Save the updated Markdown content back to the file
                    File::put($markdownFilePath, $markdownContent);

                    \Log::info("Successfully updated main-text.md for book: {$book} to remove deleted highlights.");
                } catch (\Exception $e) {
                    \Log::error("Error processing Markdown file: " . $e->getMessage());
                    return response()->json(['success' => false, 'message' => 'Error updating Markdown file.'], 500);
                }
            } else {
                \Log::error("Markdown file not found: " . $markdownFilePath);
                return response()->json(['success' => false, 'message' => 'Markdown file not found.'], 404);
            }

            return response()->json(['success' => true, 'message' => 'Highlights marked as deleted and removed from Markdown.']);
        

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
