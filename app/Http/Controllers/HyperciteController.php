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

class HyperciteController extends Controller
{
    

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
    // Log the entire request payload for initial inspection
    \Log::info('saveHyperciteBlocks called with request:', $request->all());

    $validatedData = $request->validate([
        'book' => 'required|string',
        'hypercite_id' => 'required|string',
        'blocks' => 'required|array',
        'blocks.*.id' => 'required|string', // Ensure each block has an ID
        'blocks.*.html' => 'required|string', // Ensure each block has HTML content
    ]);

    $book = $validatedData['book'];
    $hyperciteId = $validatedData['hypercite_id'];
    $blocks = $validatedData['blocks'];

    // Log validated data
    \Log::info("Validated data: Book: {$book}, Hypercite ID: {$hyperciteId}");
    \Log::info('Validated Blocks:', $blocks);

    $markdownFilePath = resource_path("markdown/{$book}/main-text.md");

    try {
        // Log the path to the Markdown file
        \Log::info("Markdown file path: {$markdownFilePath}");

        // Read Markdown file into an array of lines
        $markdownLines = file($markdownFilePath, FILE_IGNORE_NEW_LINES);
        \Log::info("Read Markdown file successfully. Number of lines: " . count($markdownLines));

        foreach ($blocks as $block) {
            $blockId = (int)$block['id'];
            $blockHtml = $block['html'];

            // Log each block being processed
            \Log::info("Processing Block: ID: {$blockId}, HTML: {$blockHtml}");

            // Convert HTML content to Markdown
            $processedMarkdown = $this->convertHtmlToMarkdown($blockHtml);
            \Log::info("Converted Markdown for Block ID {$blockId}: {$processedMarkdown}");

            if (isset($markdownLines[$blockId - 1])) {
                // Log original and updated line content
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

        return response()->json(['success' => true, 'message' => 'Hypercite blocks updated successfully.']);
    } catch (\Exception $e) {
        \Log::error("Error updating Markdown file: " . $e->getMessage());
        return response()->json(['success' => false, 'message' => 'Error updating Markdown file.'], 500);
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

        // Create a new unique ID and href for hypercite link
        $existingLinks = HyperciteLink::where('hypercite_id', $hypercite->hypercite_id)->count();
        $newHyperciteIDX = $hypercite->hypercite_id . '_' . chr(98 + $existingLinks);
        $newHrefB = "/$citation_id_b#$newHyperciteIDX";

        // Early response to frontend with new hypercite ID
        response()->json(['success' => true, 'new_hypercite_id_x' => $newHyperciteIDX])->send();

        // Insert new link
        HyperciteLink::create([
            'hypercite_id' => $hypercite->hypercite_id,
            'hypercite_id_x' => $newHyperciteIDX,
            'citation_id_b' => $citation_id_b,
            'href_b' => $newHrefB
        ]);

        // Prepare and log request for job processing
        $updatedRequest = $request->merge([
            'citation_id_a' => $citation_id_a,
            'hypercite_id' => $hypercite->hypercite_id,
            'new_href_b' => $newHrefB,
        ]);
        Log::info("Updated request prepared for", ['updatedRequest' => $updatedRequest->all()]);

        // Process jobs in the background
        //$this->processAllJobs($updatedRequest);

        // Terminate further execution
        exit;
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