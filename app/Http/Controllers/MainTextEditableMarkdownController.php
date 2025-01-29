<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

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

        // Define the path to main-text.md
        $markdownPath = resource_path("markdown/{$book}/main-text.md");

        // Save the updated content to the main-text.md file
        File::put($markdownPath, $updatedMarkdown);

        // Call the footnote-jason.py script
        try {
            $pythonScriptPath = base_path('app/python/footnote-jason.py'); // Adjust path to your script
            $process = new Process(['python3', $pythonScriptPath, $markdownPath]);
            $process->setTimeout(300); // Set a timeout of 5 minutes
            $process->run();

            if (!$process->isSuccessful()) {
                throw new ProcessFailedException($process);
            }

            // Log success or handle further logic if needed
            \Log::info("Footnote extraction completed for {$markdownPath}", [
                'output' => $process->getOutput(),
            ]);

        } catch (ProcessFailedException $e) {
            // Log errors if the script fails
            \Log::error("Footnote extraction failed for {$markdownPath}: " . $e->getMessage());
            return response()->json(['success' => false, 'error' => 'Footnote extraction failed.'], 500);
        }

        return response()->json(['success' => true, 'message' => 'Content saved and footnotes processed.']);
    }
}
