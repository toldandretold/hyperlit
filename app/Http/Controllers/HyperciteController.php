<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use App\Models\Hypercite;
use App\Models\HyperciteLink; 

class HyperciteController extends Controller

{

    public function store(Request $request)
    {
        $request->validate([
            'citation_id_a' => 'required|string', // Corrected for hypercites table
            'hypercite_id' => 'required|string',
            'hypercited_text' => 'required|string',
            'href_a' => 'required|string' // Corrected for hypercites table
        ]);

        try {
            Hypercite::create([
                'citation_id_a' => $request->input('citation_id_a'), // Corrected for hypercites table
                'hypercite_id' => $request->input('hypercite_id'),
                'hypercited_text' => $request->input('hypercited_text'),
                'href_a' => $request->input('href_a') // Corrected for hypercites table
            ]);

            return response()->json(['success' => true]);
        } catch (\Exception $e) {
            return response()->json(['success' => false, 'error' => $e->getMessage()], 500);
        }
    }

    public function saveUpdatedHTML(Request $request, $book)
    {
        // Validate the request
        $validated = $request->validate([
            'html' => 'required|string',
        ]);

        // Path to the main-text.html file for the given book
        $htmlFilePath = resource_path("markdown/{$book}/main-text.html");
        // Ensure the file exists before attempting to update
        if (!File::exists($htmlFilePath)) {
            return response()->json(['error' => 'File not found.'], 404);
        }

        // Save the updated HTML content to the file
        File::put($htmlFilePath, $validated['html']); // You can customize how this is done

        return response()->json(['success' => true]);
    }

    public function processHyperciteLink(Request $request)
    {
        $href_b = $request->input('href_b'); // Corrected for hypercite_links
        $citation_id_b = $request->input('citation_id_b'); // Corrected for hypercite_links

        // Log received data for debugging
        \Log::info('Processing hypercite link', ['href_b' => $href_b, 'citation_id_b' => $citation_id_b]);

        // Check if href_a exists in hypercites table
        $hypercite = Hypercite::where('href_a', $href_b)->first();

        if (!$hypercite) {
            return response()->json(['success' => false, 'message' => 'Href not found in hypercites table']);
        }

        // Check if there are links for this hypercite_id in hypercite_links
        $existingLink = HyperciteLink::where('hypercite_id', $hypercite->hypercite_id)->first();

        if (!$existingLink) {
            // Generate a new hypercite_id_x for the <a> tag
            $newHyperciteID = 'hypercite_id_' . uniqid();

            // Add a new link in the hypercite_links table
            HyperciteLink::create([
                'hypercite_id' => $hypercite->hypercite_id,
                'hypercite_id_x' => $newHyperciteID,
                'citation_id_b' => $citation_id_b, // Corrected to citation_id_b for hypercite_links
                'href_b' => $href_b // Corrected to href_b for hypercite_links
            ]);

            // Only return the new id without updated_href
            return response()->json([
                'success' => true,
                'new_hypercite_id_x' => $newHyperciteID
            ]);
        }

        // If a link already exists, stop processing for this <a> tag
        return response()->json(['success' => false, 'message' => 'Link already exists for this hypercite_id']);
    }




     public function processConnectedHyperCites(Request $request)
    {
        $citation_id_a = $request->input('citation_id_a');
        $htmlContent = $request->input('html');

        \Log::info('Starting processConnectedHyperCites', ['citation_id_a' => $citation_id_a]);

        $dom = new \DOMDocument();
        libxml_use_internal_errors(true);
        $dom->loadHTML($htmlContent, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
        libxml_clear_errors();

        $xpath = new \DOMXPath($dom);
        $uTags = $xpath->query('//u[@id]');

        foreach ($uTags as $uTag) {
            $hypercite_id = $uTag->getAttribute('id');
            \Log::info('Processing <u> tag', ['hypercite_id' => $hypercite_id]);

            // Fetch the corresponding hypercite record
            $hypercite = Hypercite::where('hypercite_id', $hypercite_id)->first();

            // Skip if hypercite_id not in hypercites table or if href_a is null
            if (!$hypercite || is_null($hypercite->href_a)) {
                \Log::info('Hypercite not found or href_a is null, skipping', ['hypercite_id' => $hypercite_id]);
                continue;
            }

            $connected = $hypercite->connected;
            $linkCount = HyperciteLink::where('hypercite_id', $hypercite_id)->count();
            
            \Log::info('Hypercite status before processing', [
                'connected' => $connected,
                'linkCount' => $linkCount,
                'href_in_hypercite_links' => $linkCount > 0 ? HyperciteLink::where('hypercite_id', $hypercite_id)->pluck('href') : 'No href found'
            ]);

            // Logic for wrapping and updating, with further logs for each case
            if ($connected == 0 && $linkCount > 0) {
                if ($linkCount == 1) {
                    $href_b = HyperciteLink::where('hypercite_id', $hypercite_id)->first()->href;
                    \Log::info('Wrapping <u> tag with <a> for single link', [
                        'hypercite_id' => $hypercite_id,
                        'href' => $href_b
                    ]);
                    $this->wrapUTagWithAnchor($dom, $uTag, $href_b);
                    $hypercite->connected = 1;
                    $hypercite->save();
                } elseif ($linkCount > 1) {
                    $href_z = "/$citation_id_a/{$hypercite_id}_z";
                    \Log::info('Wrapping <u> tag with <a> for multiple links', [
                        'hypercite_id' => $hypercite_id,
                        'href' => $href_z
                    ]);
                    $this->wrapUTagWithAnchor($dom, $uTag, $href_z);
                    $hypercite->connected = 2;
                    $hypercite->save();
                }
            } elseif ($connected == 1 && $linkCount > 1) {
                $href_z = "/$citation_id_a/{$hypercite_id}_z";
                \Log::info('Updating <a> href for already connected hypercite', [
                    'hypercite_id' => $hypercite_id,
                    'new_href' => $href_z
                ]);
                $this->wrapUTagWithAnchor($dom, $uTag, $href_z);
                $hypercite->connected = 2;
                $hypercite->save();
            }
        }

        $updatedHTML = $dom->saveHTML();
        file_put_contents(storage_path("app/{$citation_id_a}/main-text.html"), $updatedHTML);

        \Log::info('Completed processConnectedHyperCites', ['citation_id_a' => $citation_id_a]);

        return response()->json(['success' => true]);
    }





        private function wrapUTagWithAnchor($dom, $uTag, $href)
        {
            $aTag = $dom->createElement('a');
            $aTag->setAttribute('href', $href);

            $uTag->parentNode->replaceChild($aTag, $uTag);
            $aTag->appendChild($uTag);
        }

}
