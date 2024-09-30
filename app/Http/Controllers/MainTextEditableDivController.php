<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;

class MainTextEditableDivController extends Controller
{

    public function showEditableText($book = 'default-book')
    {
    return view('hyperlighting_div', ['book' => $book]);
    }

    
    public function saveEditedContent(Request $request)
    {
        $book = $request->input('book');
        $updatedHtml = $request->input('updated_html');

        // Save the updated content to the main-text.html file
        File::put(resource_path("markdown/{$book}/main-text.html"), $updatedHtml);

        return response()->json(['success' => true]);
    }

    

}
