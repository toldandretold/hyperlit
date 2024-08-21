<?php

use Illuminate\Support\Facades\File;

public function updateMarkdown(Request $request)
{
    $filePath = resource_path('markdown/Need_to_do.md');
    $markdown = file_get_contents($filePath);

    $highlightedText = $request->input('text');
    $startIndex = $request->input('startIndex');

    // Insert <mark> and <a> tags around the highlighted text in the markdown
    $updatedMarkdown = substr_replace($markdown, $highlightedText, $startIndex, strlen(strip_tags($highlightedText)));

    // Save the updated markdown file
    File::put($filePath, $updatedMarkdown);

    return response()->json(['success' => true]);
}
