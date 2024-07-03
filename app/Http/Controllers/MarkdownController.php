<?php 

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\File;

class MarkdownController extends Controller
{
    public function showEditor()
    {
        return view('editor');
    }

    public function getMarkdown()
    {
        // Define the path to the markdown file using resource_path helper
        $filePath = resource_path('markdown/Need_to_do.md');
        Log::info('Markdown file path: ' . $filePath);

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

        // Check if the file exists
        try {
            if (File::exists($filePath)) {
                // Get the content of the markdown file
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

        return response()->json(['content' => $markdownContent]);
    }

    public function saveMarkdown(Request $request)
    {
        try {
            $markdownContent = $request->input('markdown');
            $filePath = resource_path('markdown/Need_to_do.md');
            File::put($filePath, $markdownContent);
            Log::info('Markdown file saved successfully at path: ' . $filePath);

            return response()->json(['success' => true]);

        } catch (\Exception $e) {
            Log::error('Error saving markdown content: ' . $e->getMessage());
            return response()->json(['success' => false, 'error' => 'Failed to save markdown content. Please try again.']);
        }
    }
}
