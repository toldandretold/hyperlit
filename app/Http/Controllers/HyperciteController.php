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

    public function saveUpdatedHTML(Request $request, $book)
    {
        try {
            $validated = $request->validate([
                'html' => 'required|string',
            ]);

            $htmlFilePath = resource_path("markdown/{$book}/main-text.html");

            // Check if file exists and has correct permissions
            if (!File::exists($htmlFilePath)) {
                Log::error("File not found at path: {$htmlFilePath}");
                return response()->json(['success' => false, 'error' => 'File not found.'], 404);
            }
            if (!is_writable($htmlFilePath)) {
                Log::error("File is not writable at path: {$htmlFilePath}");
                return response()->json(['success' => false, 'error' => 'File is not writable.'], 500);
            }

            // Attempt to write to the file
            File::put($htmlFilePath, $validated['html']);

            return response()->json(['success' => true]);

        } catch (\Exception $e) {
            // Log any exceptions and return JSON error response
            Log::error('Exception caught in saveUpdatedHTML:', ['error' => $e->getMessage()]);
            return response()->json(['success' => false, 'error' => 'An error occurred.'], 500);
        }
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
