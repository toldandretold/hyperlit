<?php 

// app/Http/Controllers/MarkdownController.php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Log;

class MarkdownController extends Controller
{
    public function showEditor()
    {

        // Define the path to the markdown file
    $filePath = 'markdown-content.md';

    // Check if the file exists
    if (Storage::exists($filePath)) {
        // Get the content of the markdown file
        $markdownContent = Storage::get($filePath);
    } else {
        $markdownContent = 'Delete this and write some knowledge baby!';
    }

    return view('editor', ['markdownContent' => $markdownContent]);
}

        
    

    public function saveMarkdown(Request $request)
    {
        try {
            // Retrieve the markdown content from the request
            $markdownContent = $request->input('markdown');
            
            // Save the content to a file in the storage/app directory
            Storage::put('markdown-content.md', $markdownContent);

            return redirect()->back()->with('success', 'Markdown content saved successfully!');

        } catch (\Exception $e) {
            // Log the error for debugging
            Log::error('Error saving markdown content: ' . $e->getMessage());

            // Return an error message to the user
            return redirect()->back()->with('error', 'Failed to save markdown content. Please try again.');
        }
    }
}
