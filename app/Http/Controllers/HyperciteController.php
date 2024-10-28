<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;

class HyperciteController extends Controller
{
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
}
