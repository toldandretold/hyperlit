<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\File;
use App\Http\Controllers\MappedParsedown;

class MarkdownController extends Controller
{
    public function showEditor()
    {
        return view('editor');
    }

    public function getMarkdown(Request $request)
    {
        // Get the book identifier from the request
        $book = $request->input('book'); // Provide a default book if not specified
        Log::info('Book identifier received: ' . $book);

        // Ensure the book identifier is set correctly
        if (empty($book)) {
            Log::error('Book identifier is empty or null.');
            return response()->json(['error' => 'Book identifier is required'], 400);
        }

        // Define the path to the markdown file using the book identifier
        $filePath = resource_path("markdown/{$book}/Need_to_do.md");
        Log::info("Markdown file path for book '{$book}': " . $filePath);

        // Log the current working directory
        $currentDir = getcwd();
        Log::info('Current working directory: ' . $currentDir);

        // Log file and directory permissions
        if (File::isDirectory(resource_path('markdown'))) {
            $dirPermissions = substr(sprintf('%o', fileperms(resource_path('markdown'))), -4);
            Log::info('Markdown directory permissions: ' . $dirPermissions);
        } else {
            Log::warning('Markdown directory does not exist.');
        }

        if (File::exists($filePath)) {
            $filePermissions = substr(sprintf('%o', fileperms($filePath)), -4);
            Log::info('Markdown file permissions: ' . $filePermissions);
        } else {
            Log::warning('Markdown file does not exist.');
        }

        // Check if the file exists and get the content
        try {
            if (File::exists($filePath)) {
                $markdownContent = File::get($filePath);
                Log::info('Markdown file content loaded successfully.');
            } else {
                $markdownContent = 'Delete this and write some knowledge baby!';
                Log::warning('Markdown file does not exist, using default content.');
            }
        } catch (\Exception $e) {
            Log::error('Error accessing markdown file: ' . $e->getMessage());
            $markdownContent = 'Error accessing markdown content.';
        }

        // Process the Markdown content with MappedParsedown
        $parsedown = new MappedParsedown();
        Log::info('MappedParsedown instance created.');
        
        $parsedown->setBook($book); // Set the book identifier in MappedParsedown
        Log::info("Book identifier set in MappedParsedown: {$book}");

        $htmlContent = $parsedown->text($markdownContent); // Parse the markdown content
        Log::info('Markdown content parsed successfully.');

        return response()->json([
            'content' => $markdownContent,
            'html' => $htmlContent['html']
        ]);
    }

    public function saveMarkdown(Request $request)
    {
        // Get the book identifier from the request
        $book = $request->input('book', 'default-book'); // Provide a default book if not specified
        Log::info('Book identifier received for saving: ' . $book);

        try {
            $markdownContent = $request->input('markdown');
            $filePath = resource_path("markdown/{$book}/Need_to_do.md");
            File::put($filePath, $markdownContent);
            Log::info("Markdown file saved successfully for book '{$book}' at path: " . $filePath);

            return response()->json(['success' => true]);

        } catch (\Exception $e) {
            Log::error('Error saving markdown content: ' . $e->getMessage());
            return response()->json(['success' => false, 'error' => 'Failed to save markdown content. Please try again.']);
        }
    }
}
