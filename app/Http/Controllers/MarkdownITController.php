<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use App\Models\Highlight; // Ensure you have the Highlight model available

class MarkdownITController extends Controller
{
    public function showEditor($book)
    {
        // Define the path to the hyperlights markdown file
        $filePath = resource_path("markdown/{$book}/hyperlights.md");

        // Check if the markdown file exists
        if (!File::exists($filePath)) {
            abort(404, "Markdown file not found.");
        }

        // Get the markdown content
        $content = File::get($filePath);

        // Pass the content to the Blade view
        return view('hyperlights', compact('content', 'book'));
    }

    public function saveMarkdown(Request $request, $book)
    {
        // Define the path to the hyperlights markdown file
        $filePath = resource_path("markdown/{$book}/hyperlights.md");

        // Save the markdown content to the file
        $markdownContent = $request->input('markdown');
        File::put($filePath, $markdownContent);

        // Handle annotations if they exist
        if ($request->has('annotations')) {
            $annotations = $request->input('annotations');

            foreach ($annotations as $annotationData) {
                // Find the highlight by highlight_id and update the annotations
                $highlight = Highlight::where('highlight_id', $annotationData['highlight_id'])->first();
                if ($highlight) {
                    $highlight->annotations = $annotationData['annotation'];
                    $highlight->save();
                }
            }
        }

        // Return a success response
        return response()->json(['success' => true]);
    }

    public function showMarkdown($book)
{
    // Define the path to the markdown file based on the book
    $path = resource_path("markdown/{$book}/hyperlights.md");

    // Load the content from the markdown file (ensure the file exists)
    $content = file_exists($path) ? file_get_contents($path) : '';

    // Return the view with the content variable
    return view('hyperlights-md', ['book' => $book, 'content' => $content]);
}


    
}
