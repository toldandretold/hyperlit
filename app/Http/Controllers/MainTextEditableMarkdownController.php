<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;

class MainTextEditableMarkdownController extends Controller
{

    public function showEditableText($book = 'default-book')
    {
    return view('hyperlighting_markdown', ['book' => $book]);
    }

    
    public function saveEditedContent(Request $request)
    {
        $book = $request->input('book');
        $updatedMarkdown = $request->input('updated_markdown'); // Changed from updated_html

        // Save the updated content to the main-text.md file
        File::put(resource_path("markdown/{$book}/main-text.md"), $updatedMarkdown);

        return response()->json(['success' => true]);
    }

    

}
