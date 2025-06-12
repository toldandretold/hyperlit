<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Jobs\PandocConversionJob;
use App\Models\Citation;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class CiteCreator extends Controller
{
    public function create()
    {
        return view('CiteCreator'); // Ensure this view exists: resources/views/CiteCreator.blade.php
    }

    public function createMainTextMarkdown(Request $request)
    {
        $citation_id = $request->input('citation_id');
        $title = $request->input('title');

        if (!$citation_id || !$title) {
            return response()->json([
                'error' => 'citation_id and title are required.'
            ], 400);
        }

        $path = resource_path("markdown/{$citation_id}");

        // Create the directory if it doesn't exist
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        // Prepare the markdown content
        $markdownContent = "# {$title}\n";

        // Write to main-text.md
        File::put("{$path}/main-text.md", $markdownContent);

        return response()->json([
            'success' => true,
            'message' => "main-text.md created for citation_id {$citation_id}",
            'path' => "{$path}/main-text.md"
        ]);
    }




    public function store(Request $request)
    {
        Log::info('Form submission received', [
            'hasFile' => $request->hasFile('markdown_file'),
            'allInput' => $request->all()
        ]);

        // Define the folder path based on citation_id
        $citation_id = $request->input('citation_id');
        $path = resource_path("markdown/{$citation_id}");

        // Always create the directory if it doesn't exist
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        Log::info("Checking if a file was uploaded.");
        
        // Check if a file was uploaded
        if ($request->hasFile('markdown_file')) {
            $file = $request->file('markdown_file');
            $extension = $file->getClientOriginalExtension();

            Log::info("File extension detected: {$extension}");

            // Move the uploaded file to the target folder as "original.[file_extension]"
            $originalFilename = "original.{$extension}";
            $originalFilePath = "{$path}/{$originalFilename}";
            $file->move($path, $originalFilename);

            if ($extension === 'md') {
                // For markdown, rename the file to main-text.md
                File::move($originalFilePath, "{$path}/main-text.md");
            } elseif (in_array($extension, ['epub', 'doc', 'docx'])) {
                if ($extension === 'epub') {
                    // Handle EPUB file by unzipping
                    $epubPath = "{$path}/epub_original";
                    
                    if (!File::exists($epubPath)) {
                        File::makeDirectory($epubPath, 0755, true);
                    }

                    // Unzip and run Python scripts
                    $zip = new \ZipArchive();
                    if ($zip->open($originalFilePath) === TRUE) {
                        $zip->extractTo($epubPath);
                        $zip->close();
                        Log::info("EPUB file unzipped successfully");

                        // Run the Python scripts after EPUB decompression
                        $this->runPythonScripts($path);
                    } else {
                        Log::error("Failed to unzip the EPUB file");
                        return redirect()->back()->with('error', 'Failed to unzip the EPUB file.');
                    }
                } else {
                    // Handle DOC or DOCX using Pandoc Job
                    $filename = 'main-text.md';
                    $markdownPath = "{$path}/{$filename}";

                    Log::info("Dispatching Pandoc job with input: {$originalFilePath} and output: {$markdownPath}");
                    
                    // Dispatch the job to run Pandoc in the background
                    PandocConversionJob::dispatch($originalFilePath, $markdownPath);
                }
            }
        } else {
            Log::info("No file uploaded - creating basic markdown file");
            
            // Create a basic markdown file with citation info
            $title = $request->input('title') ?? 'Untitled';
            $markdownContent = "# {$title}\n\n";
            $markdownContent .= "**Author:** " . ($request->input('author') ?? 'Unknown') . "\n";
            $markdownContent .= "**Year:** " . ($request->input('year') ?? 'Unknown') . "\n";
            
            File::put("{$path}/main-text.md", $markdownContent);
        }

        // Wait for main-text.md to be created (for async jobs)
        $mainTextPath = "{$path}/main-text.md";
        $attempts = 0;
        while (!File::exists($mainTextPath) && $attempts < 5) {
            Log::info("Waiting for main-text.md to be created (attempt {$attempts})...");
            sleep(1);
            $attempts++;
        }

        // Redirect to the citation page
        if (File::exists($mainTextPath)) {
            Log::info("main-text.md created successfully, redirecting to /{$citation_id}");
            return redirect("/{$citation_id}")->with('success', 'File processed successfully!');
        }

        Log::error("Failed to create main-text.md after 5 attempts.");
        return redirect()->back()->with('error', 'Failed to process file. Please try again.');
    }

    // Keep the Python script runner
    private function runPythonScripts(string $path)
    {
        try {
            // Run clean.py script
            $cleanProcess = new Process(['python3', base_path('app/python/clean.py'), "{$path}/epub_original"]);
            $cleanProcess->run();

            if (!$cleanProcess->isSuccessful()) {
                Log::error('Clean.py error output: ' . $cleanProcess->getErrorOutput());
                throw new ProcessFailedException($cleanProcess);
            }
            Log::info("clean.py executed successfully.");

            // Run combine.py script
            $combineProcess = new Process(['python3', base_path('app/python/combine.py'), "{$path}/epub_original"]);
            $combineProcess->run();

            if (!$combineProcess->isSuccessful()) {
                Log::error('Combine.py error output: ' . $combineProcess->getErrorOutput());
                throw new ProcessFailedException($combineProcess);
            }
            Log::info("combine.py executed successfully.");

        } catch (ProcessFailedException $e) {
            Log::error("Python script execution failed: " . $e->getMessage());
            throw $e;
        }
    }

 public function createNewMarkdown(Request $request)
    {
        $citation_id = $request->input('citation_id');
        $title       = $request->input('title');

        if (! $citation_id || ! $title) {
            return response()->json([
                'error' => 'citation_id and title are required.'
            ], 400);
        }

        $path = resource_path("markdown/{$citation_id}");

        if (! File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        // Write the markdown file
        File::put("{$path}/main-text.md", "# {$title}\n");

        return response()->json([
            'success' => true,
            'message' => "main-text.md created for {$citation_id}",
            'path'    => "{$path}/main-text.md"
        ]);
    }

}
