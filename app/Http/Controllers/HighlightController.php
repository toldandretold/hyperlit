<?php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;
use App\Models\Highlight;
use League\CommonMark\CommonMarkConverter;

class HighlightController extends Controller
{
    public function store(Request $request)
    {
        $textSegment = $request->input('text');
        $hash = $request->input('hash'); // Use the hash generated on the frontend
        $book = $request->input('book'); // Ensure book is passed in the request

        // Check if the fingerprint hash already exists
        $existingFingerprint = DB::table('text_fingerprints')->where('hash', $hash)->first();

        if ($existingFingerprint) {
            // Handle the case where the fingerprint already exists
            return response()->json(['success' => false, 'message' => 'Duplicate highlight'], 400);
        }

        // Store the new highlight and fingerprint
        $highlight = new Highlight();
        $highlight->text = $textSegment;
        $highlight->highlight_id = $hash; // Use hash as highlight_id
        $highlight->book = $book;
        $highlight->numerical = $request->input('numerical'); // Numerical value for ordering
        $highlight->save();

        // Save the fingerprint
        DB::table('text_fingerprints')->insert([
            'hash' => $hash,
            'text_segment' => $textSegment,
            'source_id' => $highlight->id, // Link to the highlight's ID
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->updateHyperLightsMarkdown($book);

        return response()->json(['success' => true, 'data' => $highlight]);
    }

    private function updateHyperLightsMarkdown($book)
    {
        $filePath = resource_path("markdown/{$book}/hyper-lights.md");
        $highlights = Highlight::where('book', $book)->orderBy('numerical')->get(); // Order by numerical value

        $content = "";

        foreach ($highlights as $highlight) {
            $content .= "\"{$highlight->text}\" <a href=\"/hyper-lights#{$highlight->highlight_id}\">↩</a>\n\n";
        }

        // Save the updated content to hyper-lights.md
        File::put($filePath, $content);
    }



    public function updateMarkdown(Request $request)
    {
        $book = $request->input('book');
        
        \Log::info('Book in request:', ['book' => $request->input('book')]);

        if (!$book) {
        \Log::error('Book is not set in the request');
        return response()->json(['success' => false, 'message' => 'Book not provided'], 400);
    }

        $filePath = resource_path("markdown/{$book}/main-text.md");

        \Log::info('Updating file at path: ' . $filePath);

        $markdown = file_get_contents($filePath);
        $highlightedText = $request->input('text');
        $hash = $request->input('hash'); // Use the hash provided from the frontend

        // Convert Markdown to HTML
        $htmlContent = $this->convertMarkdownToHtml($markdown);

        // Search within the HTML content
        $positionInHtml = strpos($htmlContent, $highlightedText);

        if ($positionInHtml !== false) {
            // Calculate the overall position within the Markdown
            $overallPosition = strpos($markdown, strip_tags($highlightedText));

            if ($overallPosition !== false) {
                $wrappedText = "<mark><a href=\"/hyper-lights#{$hash}\" id=\"{$hash}\">" . $highlightedText . "</a></mark>";
                $updatedMarkdown = substr_replace($markdown, $wrappedText, $overallPosition, strlen($highlightedText));

                File::put($filePath, $updatedMarkdown);

                return response()->json(['success' => true]);
            }
        }

        \Log::error("Text not found or mismatch for book: {$book}, highlight: {$highlightedText}");
        return response()->json(['success' => false, 'message' => 'Text not found or mismatch'], 400);
    }

    public function deleteHighlight(Request $request)
    {
        $hash = $request->input('hash'); // Use hash from request

        $highlight = Highlight::where('highlight_id', $hash)->first(); // Find by hash

        if ($highlight) {
            $highlight->delete();

            // Remove the highlight from the markdown file
            $this->removeHighlightFromMarkdown($highlight->book, $highlight->text);

            // Update the hyper-lights.md file to remove the deleted highlight
            $this->updateHyperLightsMarkdown($highlight->book);

            return response()->json(['success' => true]);
        } else {
            return response()->json(['success' => false, 'message' => 'Highlight not found'], 404);
        }
    }

    private function removeHighlightFromMarkdown($book, $highlightedText)
    {
        $filePath = resource_path("markdown/{$book}/main-text.md");
        $markdown = file_get_contents($filePath);

        // Generate hash from text for removal
        $hash = $this->generateFingerprint($highlightedText);

        // Update the pattern to match the hash
        $pattern = "/<mark><a href=\"\/hyper-lights#{$hash}\" id=\"{$hash}\">(.*?)<\/a><\/mark>/";
        $updatedMarkdown = preg_replace($pattern, '$1', $markdown);

        File::put($filePath, $updatedMarkdown);
    }

    // Convert markdown content to HTML
    private function convertMarkdownToHtml($markdown)
    {
        $converter = new CommonMarkConverter();
        return $converter->convertToHtml($markdown);
    }

    // Generate fingerprint hash for a text segment
    private function generateFingerprint($textSegment)
    {
        return hash('sha256', $textSegment);
    }

    // Check if a fingerprint hash already exists
    public function checkFingerprint(Request $request)
    {
        $hash = $request->input('hash');
        $exists = DB::table('text_fingerprints')->where('hash', $hash)->exists();
        return response()->json(['exists' => $exists]);
    }
}
