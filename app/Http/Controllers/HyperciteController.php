<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Bus;
use App\Models\Hypercite;
use App\Models\HyperciteLink; 
use App\Jobs\ProcessConnectedHyperCitesJob;
use App\Jobs\ProcessCitationIdBLinksJob;
use App\Events\ProcessComplete;
use Illuminate\Support\Facades\Log;
use App\Traits\UpdateMarkdownTimestamps;

class HyperciteController extends Controller


{
    use UpdateMarkdownTimestamps;

    public function store(Request $request)
    {
        $validatedData = $request->validate([
            'citation_id_a' => 'required|string',
            'hypercite_id' => 'required|string',
            'hypercited_text' => 'required|string',
            'href_a' => 'required|string'
        ]);

        try {
            Hypercite::create($validatedData);
            return response()->json(['success' => true]);
        } catch (\Exception $e) {
            // Log the exception details for debugging
            Log::error('Error saving hypercite data:', ['error' => $e->getMessage()]);
            return response()->json(['success' => false, 'error' => 'Failed to save hypercite data.'], 500);
        }
    }

    public function saveHyperciteBlocks(Request $request)
{
    \Log::info('saveHyperciteBlocks called with request:', $request->all());

    $validatedData = $request->validate([
        'book' => 'required|string',
        'hypercite_id' => 'required|string',
        'blocks' => 'required|array',
        'blocks.*.id' => 'required|string',
        'blocks.*.html' => 'required|string',
    ]);

    $book = $validatedData['book'];
    $hyperciteId = $validatedData['hypercite_id'];
    $blocks = $validatedData['blocks'];

    \Log::info("Validated data: Book: {$book}, Hypercite ID: {$hyperciteId}");
    \Log::info('Validated Blocks:', $blocks);

    $markdownFilePath = resource_path("markdown/{$book}/main-text.md");

    try {
        \Log::info("Markdown file path: {$markdownFilePath}");

        // Read Markdown file into an array
        $markdownLines = file($markdownFilePath, FILE_IGNORE_NEW_LINES);
        \Log::info("Read Markdown file successfully. Number of lines: " . count($markdownLines));

        foreach ($blocks as $block) {
            $blockId = (int)$block['id'];
            $blockHtml = $block['html'];

            \Log::info("Processing Block: ID: {$blockId}, HTML: {$blockHtml}");

            // Convert HTML content to Markdown
            $processedMarkdown = $this->convertHtmlToMarkdown($blockHtml);
            \Log::info("Converted Markdown for Block ID {$blockId}: {$processedMarkdown}");

            if (isset($markdownLines[$blockId - 1])) {
                $originalLine = $markdownLines[$blockId - 1];
                \Log::info("Original line at Block ID {$blockId}: {$originalLine}");
                \Log::info("Updated line at Block ID {$blockId}: {$processedMarkdown}");

                // Replace the corresponding line in the Markdown file
                $markdownLines[$blockId - 1] = $processedMarkdown;
            } else {
                \Log::warning("Block ID {$blockId} not found in Markdown file.");
            }
        }

        // Write the updated Markdown content back to the file
        file_put_contents($markdownFilePath, implode(PHP_EOL, $markdownLines) . PHP_EOL);
        \Log::info("Successfully updated Markdown file for book: {$book}");

        // Get the latest Markdown content
        $updatedMarkdownContent = file_get_contents($markdownFilePath);

        // Get the last modified timestamp
        $markdownLastModified = filemtime($markdownFilePath);

        
        return response()->json($this->updateLatestMarkdownTimestamp($book));
        
    } catch (\Exception $e) {
        \Log::error("Error updating Markdown file: " . $e->getMessage());
        return response()->json(['success' => false, 'message' => 'Error updating Markdown file.'], 500);
    }
}



    private function convertHtmlToMarkdown($html)
    {
        $html = '<div>' . $html . '</div>';
        $doc = new \DOMDocument();
        @$doc->loadHTML(mb_convert_encoding($html, 'HTML-ENTITIES', 'UTF-8'));

        $markdownContent = '';

        foreach ($doc->getElementsByTagName('div')->item(0)->childNodes as $node) {
            if ($node->nodeType === XML_TEXT_NODE) {
                $markdownContent .= htmlspecialchars($node->nodeValue, ENT_QUOTES | ENT_HTML5);
            } elseif ($node->nodeType === XML_ELEMENT_NODE) {
                $markdownContent .= $doc->saveHTML($node);
            }
        }

        return trim($markdownContent);
    }



   public function processHyperCiteLink(Request $request)
{
    $href_a = $request->input('href_a');
    $citation_id_b = $request->input('citation_id_b');

    // Extract citation_id_a from href_a
    $parsedUrl = parse_url($href_a);
    $citation_id_a = trim($parsedUrl['path'] ?? '', '/');

    // Check for and retrieve the hypercite record
    $hypercite = Hypercite::where('href_a', $href_a)->first();
    if (!$hypercite) {
        return response()->json(['success' => false, 'message' => 'Href not found in hypercites table']);
    }

    // Create a new unique ID and href for the hypercite link
    $existingLinks = HyperciteLink::where('hypercite_id', $hypercite->hypercite_id)->count();
    $newHyperciteIDX = $hypercite->hypercite_id . '_' . chr(98 + $existingLinks);
    $newHrefB = "/$citation_id_b#$newHyperciteIDX";

    $newLink = HyperciteLink::create([
        'hypercite_id' => $hypercite->hypercite_id,
        'hypercite_id_x' => $newHyperciteIDX,
        'citation_id_b' => $citation_id_b,
        'href_b' => $newHrefB
    ]);

    Log::info("New HyperciteLink created:", [
        'hypercite_id' => $newLink->hypercite_id,
        'citation_id_b' => $newLink->citation_id_b,
        'href_b' => $newLink->href_b
    ]);

    // Trigger ProcessConnectedHyperCitesJob for citation_a
    ProcessConnectedHyperCitesJob::dispatch($citation_id_a);
    Log::info("ProcessConnectedHyperCitesJob dispatched for citation_id_a: {$citation_id_a}");

    // Send the response with the new ID
    return response()->json([
        'success' => true,
        'new_hypercite_id_x' => $newHyperciteIDX
    ]);
}




    public function processConnectedHyperCites(Request $request)
        {
            $citation_id_a = $request->input('citation_id_a');

            // Dispatch the job
            ProcessConnectedHyperCitesJob::dispatch($citation_id_a);
            Log::info("ProcessConnectedHyperCitesJob dispatched for citation_id_a: {$citation_id_a}");

            // Broadcast the event
            event(new ProcessComplete("Hypercited"));
            Log::info("ProcessComplete event broadcast for citation_id_a: {$citation_id_a}");

            return response()->json(['success' => true]);
        }  
}