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

    public function store(Request $request)
{
    // Log the incoming form data
    Log::info('Form data submitted:', $request->all());

    // Save citation data
    $citation = new Citation();
    $citation->bibtex = $request->input('bibtex') ?? null;
    $citation->type = $request->input('type') ?? null;
    $citation->citation_id = $request->input('citation_id') ?? null;
    $citation->author = $request->input('author') ?? null;
    $citation->title = $request->input('title') ?? null;
    $citation->year = $request->input('year') ?? null;
    $citation->url = $request->input('url') ?? null;
    $citation->pages = $request->input('pages') ?? null;
    $citation->journal = $request->input('journal') ?? null;
    $citation->publisher = $request->input('publisher') ?? null;
    $citation->school = $request->input('school') ?? null;
    $citation->note = $request->input('note') ?? null;
    $citation->location = "/resources/markdown/{$request->input('citation_id')}";
    $citation->save();

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

                Log::info("EPUB Path: {$epubPath}");
                Log::info("Original File Path: {$originalFilePath}");

                // First attempt to unzip using ZipArchive
                $zip = new \ZipArchive();
                if ($zip->open($originalFilePath) === TRUE) {
                    $zip->extractTo($epubPath);
                    $zip->close();
                    Log::info("EPUB file unzipped successfully using ZipArchive to: {$epubPath}");

                    // Run the Python scripts after EPUB decompression
                    $this->runPythonScripts($path);
                } else {
                    Log::warning("Failed to unzip the EPUB file using ZipArchive. Trying system unzip...");

                    // Try using the system's 'unzip' command
                    $unzipCommand = "unzip " . escapeshellarg($originalFilePath) . " -d " . escapeshellarg($epubPath);
                    $unzipProcess = new \Symfony\Component\Process\Process([$unzipCommand]);
                    $unzipProcess->run();

                    Log::info('Unzip command output: ' . $unzipProcess->getOutput());
                    Log::info('Unzip command error output: ' . $unzipProcess->getErrorOutput());

                    if ($unzipProcess->isSuccessful()) {
                        Log::info("EPUB file unzipped successfully using system unzip to: {$epubPath}");

                        // Run the Python scripts after EPUB decompression
                        $this->runPythonScripts($path);
                    } else {
                        Log::error("Failed to unzip the EPUB file using both ZipArchive and system unzip.");
                        return redirect()->back()->with('error', 'Failed to unzip the EPUB file.');
                    }
                }
            } else {
                // Handle DOC or DOCX using Pandoc
                $filename = 'main-text.md';
                $markdownPath = "{$path}/{$filename}";

                Log::info("Dispatching Pandoc job with input: {$originalFilePath} and output: {$markdownPath}");
                
                // Dispatch the job to run Pandoc in the background
                PandocConversionJob::dispatch($originalFilePath, $markdownPath);
            }
        }
    } else {
        Log::info("No file uploaded.");
        // No file was uploaded, so create a citation.html file with citation details
        $filename = 'citation.html';
        $htmlContent = "
        <html>
        <head><title>{$citation->title}</title></head>
        <body>
            <h1>{$citation->title}</h1>
            <p><strong>Author:</strong> {$citation->author}</p>
            <p><strong>Year:</strong> {$citation->year}</p>
            <p><strong>Journal:</strong> {$citation->journal}</p>
            <p><strong>Pages:</strong> {$citation->pages}</p>
            <p><strong>Publisher:</strong> {$citation->publisher}</p>
            <p><strong>URL:</strong> {$citation->url}</p>
        </body>
        </html>";

        // Write the content to citation.html
        File::put("{$path}/{$filename}", $htmlContent);
    }

    // Define the expected main-text.html path
    $mainTextPath = "{$path}/main-text.md";
    Log::info("Expected path for main-text.html: {$mainTextPath}");

    // Retry mechanism: Check for main-text.html file for up to 5 seconds
    $attempts = 0;
    while (!File::exists($mainTextPath) && $attempts < 5) {
        Log::info("Waiting for main-text.html to be created (attempt {$attempts})...");
        sleep(1);  // Wait for 1 second before rechecking
        $attempts++;
    }

    // Check if the file now exists and redirect
    if (File::exists($mainTextPath)) {
        Log::info("main-text.md created successfully, redirecting to /{$citation_id}");
        return redirect("/{$citation_id}")->with('success', 'Book entry created and main-text.html is ready!');
    }


    Log::error("Failed to create main-text.html after 5 attempts.");
    return redirect()->back()->with('error', 'Failed to generate main-text.html. Please try again.');
}

private function runPythonScripts(string $path)
{
    try {
        // Run clean.py script and pass the EPUB folder path as an argument
        $cleanProcess = new Process(['python3', base_path('app/python/clean.py'), "{$path}/epub_original"]);
        $cleanProcess->run();

        if (!$cleanProcess->isSuccessful()) {
            Log::error('Clean.py error output: ' . $cleanProcess->getErrorOutput());
            throw new ProcessFailedException($cleanProcess);
        }
        Log::info("clean.py executed successfully.");

        // Run combine.py script and pass the EPUB folder path as an argument
        $combineProcess = new Process(['python3', base_path('app/python/combine.py'), "{$path}/epub_original"]);
        $combineProcess->run();

        if (!$combineProcess->isSuccessful()) {
            Log::error('Combine.py error output: ' . $combineProcess->getErrorOutput());
            throw new ProcessFailedException($combineProcess);
        }
        Log::info("combine.py executed successfully.");

    } catch (ProcessFailedException $e) {
        Log::error("Python script execution failed: " . $e->getMessage());
        return redirect()->back()->with('error', 'Failed to run Python scripts.');
    }
}


}
