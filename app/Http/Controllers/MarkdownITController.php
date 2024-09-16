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

    // Existing show method for the test markdown file
    public function show()
    {
        // Load the markdown file content
        $content = File::exists(storage_path('app/public/test.md')) ? File::get(storage_path('app/public/test.md')) : '';

        // Pass the markdown content to the view
        return view('markdown-it-editor', compact('content'));
    }

    // Existing save method for the test markdown file
    public function save(Request $request)
    {
        // Validate and save the new markdown content
        $request->validate([
            'markdown_it_content' => 'required|string',
        ]);

        File::put(storage_path('app/public/test.md'), $request->markdown_content);

        return redirect()->route('markdown.show')->with('success', 'Markdown saved successfully!');
    }
}
