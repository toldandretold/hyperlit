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

// processHyperCiteLink: Creates a new hypercite link and updates citation_id_a and citation_id_b
public function processHyperCiteLink(Request $request)
{
    $href_a = $request->input('href_a');
    $citation_id_b = $request->input('citation_id_b');

    // Dispatch a job to handle the hypercite link processing
    ProcessHyperCiteLinkJob::dispatch($href_a, $citation_id_b);

    return response()->json(['success' => true, 'message' => 'Processing started in background']);
}


// processConnectedHyperCites: Updates <u> tags in citation_id_a and <a> tags in citation_id_b
public function processConnectedHyperCites(Request $request)
{
    $citation_id_a = $request->input('citation_id_a');
    $htmlContent = $request->input('html');

    // Dispatch a job to handle the connected hypercite processing
    ProcessConnectedHyperCitesJob::dispatch($citation_id_a, $htmlContent);

    return response()->json(['success' => true, 'message' => 'Connected hypercite processing started in background']);
}





        private function wrapUTagWithAnchor($dom, $uTag, $href)
        {
            $aTag = $dom->createElement('a');
            $aTag->setAttribute('href', $href);

            $uTag->parentNode->replaceChild($aTag, $uTag);
            $aTag->appendChild($uTag);
        }

}
