<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Symfony\Component\Process\Exception\ProcessFailedException;
use Symfony\Component\Process\Process;

class PandocBookController extends Controller
{
    public function show($filename)
    {
        // Path to the markdown file
        $markdownPath = resource_path("markdown/{$filename}.md");

        if (!file_exists($markdownPath)) {
            abort(404, 'File not found.');
        }

        // Path for the output HTML
        $outputHtmlPath = storage_path('app/output.html');

        // Execute Pandoc command
        $process = new Process(['pandoc', $markdownPath, '-o', $outputHtmlPath]);
        $process->run();

        // Check if the process was successful
        if (!$process->isSuccessful()) {
            throw new ProcessFailedException($process);
        }

        // Get the converted HTML content
        $htmlContent = file_get_contents($outputHtmlPath);

        // Return the view with the HTML content
        return view('book.display', ['htmlContent' => $htmlContent]);
    }
}
