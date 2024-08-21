<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use App\Models\Highlight; // Import the Highlight model

class HighlightController extends Controller
{
    public function store(Request $request)
    {
        $highlight = new Highlight();
        $highlight->text = $request->input('text'); // Store plain text
        $highlight->highlight_id = $request->input('id');
        $highlight->numerical = $request->input('numerical');
        $highlight->save();

        return response()->json(['success' => true, 'data' => $highlight]);
            
    }

     public function updateMarkdown(Request $request)
    {
        $filePath = resource_path('markdown/Need_to_do.md');
        $markdown = file_get_contents($filePath);

        $highlightedText = $request->input('text'); // Plain text from the request
        $highlightId = $request->input('highlightId');

        // Strip existing HTML tags from the markdown for matching purposes
        $strippedMarkdown = strip_tags($markdown);

        // Ensure the highlighted text exists in the stripped markdown
        $position = strpos($strippedMarkdown, $highlightedText);

        if ($position !== false) {
            // Calculate the correct position in the original markdown
            $actualPosition = $this->findOriginalPosition($strippedMarkdown, $markdown, $highlightedText, $position);

            // Wrap the matched text with <mark> and <a> tags, including the correct ID
            $wrappedText = "<mark><a href=\"/hyper-lights#{$highlightId}\" id=\"{$highlightId}\">" . $highlightedText . "</a></mark>";

            // Replace the original text with the wrapped text in the markdown file
            $updatedMarkdown = substr_replace($markdown, $wrappedText, $actualPosition, strlen($highlightedText));

            // Save the updated markdown file
            File::put($filePath, $updatedMarkdown);

            return response()->json(['success' => true]);
        } else {
            // Handle case where the text is not found in the markdown file
            return response()->json(['success' => false, 'message' => 'Text not found or mismatch'], 400);
        }
    }

    // Helper function to find the correct position in the original markdown
    private function findOriginalPosition($strippedMarkdown, $originalMarkdown, $highlightedText, $position)
    {
        $currentIndex = 0;
        $actualPosition = 0;

        // Iterate through the stripped markdown and match with the original markdown
        while ($currentIndex < strlen($strippedMarkdown)) {
            if ($strippedMarkdown[$currentIndex] === $highlightedText[0]) {
                // Check if this is the correct match
                if (substr($strippedMarkdown, $currentIndex, strlen($highlightedText)) === $highlightedText) {
                    return $actualPosition;
                }
            }

            // Move to the next character
            $currentIndex++;
            $actualPosition++;

            // Skip over HTML tags in the original markdown
            while (isset($originalMarkdown[$actualPosition]) && $originalMarkdown[$actualPosition] === '<') {
                while ($originalMarkdown[$actualPosition] !== '>') {
                    $actualPosition++;
                }
                $actualPosition++;
            }
        }

        return $actualPosition;
    }

        public function deleteHighlight(Request $request)
            {
            $highlightId = $request->input('id');

            // Find the highlight by its ID and mark it as deleted
            $highlight = Highlight::where('highlight_id', $highlightId)->first();

            if ($highlight) {
                $highlight->delete(); // Soft delete the highlight

                // Also, remove the highlight from the markdown file
                $this->removeHighlightFromMarkdown($highlight->text);

        return response()->json(['success' => true]);
    } else {
        return response()->json(['success' => false, 'message' => 'Highlight not found'], 404);
                }
            }

        // Helper method to remove the highlight from the markdown file
        private function removeHighlightFromMarkdown($highlightedText)
        {
            $filePath = resource_path('markdown/Need_to_do.md');
            $markdown = file_get_contents($filePath);

            // Find and remove the <mark> and <a> tags from the markdown
            $pattern = '/<mark><a href="\/hyper-lights#.*?" id=".*?">(.*?)<\/a><\/mark>/';
            $updatedMarkdown = preg_replace($pattern, '$1', $markdown);

            // Save the updated markdown file
            File::put($filePath, $updatedMarkdown);
        }

}
