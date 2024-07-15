<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

class PageController extends Controller
{
    public function showMainPage()
    {
        // Load the main page view
        return view('editor');
    }

    public function createPage(Request $request)
    {
        $id = 'page-' . Str::uuid();
        $fileName = $id . '.html';
        $filePath = public_path('pages/' . $fileName);

        // Create the new page content
        $newPageContent = "
        <!DOCTYPE html>
        <html lang='en'>
        <head>
            <meta charset='UTF-8'>
            <meta name='viewport' content='width=device-width, initial-scale=1.0'>
            <title>$id</title>
        </head>
        <body>
            <h1>$id</h1>
            <p>This is a dynamically created page.</p>
            <a href='" . url('/') . "#$id'>Back to Main Page</a>
        </body>
        </html>
        ";

        // Save the new page to the pages folder
        if (File::put($filePath, $newPageContent) !== false) {
            // Return success response
            return response()->json(['success' => true, 'id' => $id, 'url' => url('pages/' . $fileName)]);
        } else {
            // Return error response
            return response()->json(['success' => false]);
        }
    }

    public function saveContent(Request $request)
    {
        $content = $request->input('content');
        $filePath = resource_path('views/deepnote.blade.php');

        // Save the updated content to the index.blade.php file
        if (File::put($filePath, $content) !== false) {
            return response()->json(['success' => true]);
        } else {
            return response()->json(['success' => false]);
        }
    }
}
