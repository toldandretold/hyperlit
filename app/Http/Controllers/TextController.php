<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use League\CommonMark\CommonMarkConverter;

class TextController extends Controller
{
    public function show($book)
    {
        // Define paths to the markdown files based on the folder name
        $markdownPath = resource_path("markdown/{$book}/main-text.md");
        $hyperLightsPath = resource_path("markdown/{$book}/hyper-lights.md");

        // Check if the main text markdown file exists
        if (!File::exists($markdownPath)) {
            abort(404, "Book not found");
        }

        // Load the main text markdown file
        $markdown = File::get($markdownPath);
        $converter = new CommonMarkConverter();
        $html = $converter->convertToHtml($markdown);

        // Pass the HTML and paths to the Blade template
        return view('hyperlightingM', [
            'html' => $html,
            'book' => $book,
            'hyperLightsPath' => $hyperLightsPath
        ]);
    }
}
