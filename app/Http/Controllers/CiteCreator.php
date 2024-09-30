<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Jobs\PandocConversionJob;
use App\Models\Citation;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class CiteCreator extends Controller
{
    public function create()
    {
        return view('CiteCreator'); // Ensure this view exists: resources/views/CiteCreator.blade.php
    }

    public function store(Request $request)
    {
        // Log the incoming form data
        \Log::info('Form data submitted:', $request->all());

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
        $path = resource_path("markdown/{$request->input('citation_id')}");

        // Always create the directory if it doesn't exist
        if (!File::exists($path)) {
            File::makeDirectory($path, 0755, true);
        }

        // Check if a file was uploaded
        if ($request->hasFile('markdown_file')) {
            $file = $request->file('markdown_file');
            $extension = $file->getClientOriginalExtension();

            // Move the uploaded file to the target folder as "original.[file_extension]"
            $originalFilename = "original.{$extension}";
            $originalFilePath = "{$path}/{$originalFilename}";
            $file->move($path, $originalFilename);

            if ($extension === 'md') {
                // For markdown, rename the file to main-text.md
                File::move($originalFilePath, "{$path}/main-text.md");
            } elseif (in_array($extension, ['epub', 'doc', 'docx'])) {
                // If it's EPUB, DOC, or DOCX, dispatch Pandoc conversion job
                $filename = 'main-text.md';
                $markdownPath = "{$path}/{$filename}";

                Log::info("Dispatching Pandoc job with input: {$originalFilePath} and output: {$markdownPath}");
                
                // Dispatch the job to run Pandoc in the background
                PandocConversionJob::dispatch($originalFilePath, $markdownPath);
            }
        } else {
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

        // Redirect after everything is done
        return redirect()->back()->with('success', 'Book entry created and conversion started!');
    }
}
