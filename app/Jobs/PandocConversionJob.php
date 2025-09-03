<?php

namespace App\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;

class PandocConversionJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    protected $citation_id;
    protected $inputFilePath;

    /**
     * Create a new job instance.
     *
     * @param string $citation_id
     * @param string $inputFilePath
     * @return void
     */
    public function __construct(string $citation_id, string $inputFilePath)
    {
        $this->citation_id = $citation_id;
        $this->inputFilePath = $inputFilePath;
    }

    /**
     * Execute the job.
     *
     * @return void
     */
    public function handle()
    {
        $basePath = resource_path("markdown/{$this->citation_id}");
        $htmlOutputPath = "{$basePath}/intermediate.html";
        $pythonScriptPath = base_path('app/Python/process_document.py');

        Log::info("PandocConversionJob started for citation_id: {$this->citation_id}");

        try {
            // Step 1: Convert DOCX to HTML using Pandoc
            Log::info("Step 1: Converting DOCX to HTML...", [
                'input' => $this->inputFilePath,
                'output' => $htmlOutputPath
            ]);

            $pandocProcess = new Process([
                'pandoc',
                $this->inputFilePath,
                '-o',
                $htmlOutputPath,
                '--extract-media=' . $basePath // Extracts images to the folder
            ]);
            $pandocProcess->setTimeout(300); // 5 minutes timeout
            $pandocProcess->run();

            if (!$pandocProcess->isSuccessful()) {
                throw new ProcessFailedException($pandocProcess);
            }
            Log::info("Pandoc conversion successful.");

            // Step 2: Run the Python script on the generated HTML
            $pythonBin = env('PYTHON_PATH', 'python3');

            Log::info("Step 2: Running Python script...", [
                'python'     => $pythonBin,
                'script'     => $pythonScriptPath,
                'html_input' => $htmlOutputPath,
                'output_dir' => $basePath,
                'book_id'    => $this->citation_id,
            ]);

            // Build the command as an array so Symfony handles quoting safely
            $pythonProcess = new Process([
                $pythonBin,
                $pythonScriptPath,
                $htmlOutputPath,
                $basePath,
                (string) $this->citation_id, // Pass citation_id as book_id
            ]);
            $pythonProcess->setTimeout(300);
            $pythonProcess->run();

            if (!$pythonProcess->isSuccessful()) {
                throw new ProcessFailedException($pythonProcess);
            }
            Log::info("Python script executed successfully. JSON files created.");

        } catch (ProcessFailedException $exception) {
            Log::error("PandocConversionJob failed for {$this->citation_id}", [
                'error' => $exception->getMessage(),
                'stdout' => $exception->getProcess()->getOutput(),
                'stderr' => $exception->getProcess()->getErrorOutput(),
            ]);
        } finally {
            // Step 3: Clean up the intermediate HTML file
            if (File::exists($htmlOutputPath)) {
                File::delete($htmlOutputPath);
                Log::info("Cleaned up intermediate file: {$htmlOutputPath}");
            }
        }
    }
}