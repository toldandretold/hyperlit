<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class FootnotesController extends Controller
{
    /**
     * Refresh the footnotes for a given book.
     *
     * @param string $book
     * @return \Illuminate\Http\JsonResponse
     */
    public function refreshFootnotes($book)
    {
        // Validate $book to avoid directory traversal or injection attacks.
        if (!preg_match('/^[A-Za-z0-9_-]+$/', $book)) {
            Log::error("❌ Invalid book identifier provided: {$book}");
            return response()->json([
                'success' => false,
                'message' => 'Invalid book identifier'
            ], 400);
        }

        $markdownFilePath = resource_path("markdown/{$book}/main-text.md");
        $footnotesFilePath = resource_path("markdown/{$book}/footnotes.json");

        Log::info("📝 Regenerating footnotes for: {$book}");

        // Verify markdown file exists
        if (!file_exists($markdownFilePath)) {
            Log::error("❌ Markdown file not found at: {$markdownFilePath}");
            return response()->json([
                'success' => false,
                'message' => 'Markdown file not found'
            ], 404);
        }

        // Get Python path; use a fallback if necessary.
        $pythonBin = trim(shell_exec('which python3'));
        if (empty($pythonBin)) {
            $pythonBin = "/usr/local/bin/python3"; // fallback
        }
        Log::info("🐍 Using Python at: {$pythonBin}");

        // Verify Python script exists and is executable.
        $pythonScriptPath = base_path("App/Python/footnote-jason.py");
        if (!file_exists($pythonScriptPath)) {
            Log::error("❌ Python script not found at: {$pythonScriptPath}");
            return response()->json([
                'success' => false,
                'message' => 'Python script not found'
            ], 500);
        }

        // Ensure the script is executable.
        chmod($pythonScriptPath, 0755);

        // Build command with properly escaped paths.
        $escapedMarkdownPath = escapeshellarg($markdownFilePath);
        $escapedScriptPath   = escapeshellarg($pythonScriptPath);
        $escapedOutputPath   = escapeshellarg($footnotesFilePath);

        // Now the command passes both the input markdown file path and the desired output JSON path.
        $command = "{$pythonBin} {$escapedScriptPath} {$escapedMarkdownPath} {$escapedOutputPath} 2>&1";

        // Execute the command and capture output.
        $output = shell_exec($command);

        if ($output === null) {
            Log::error("❌ Python script execution failed (null output)");
            return response()->json([
                'success' => false,
                'message' => 'Error executing the Python script'
            ], 500);
        } else {
            Log::info("🔄 Python script output: " . $output);

            // Verify footnotes file was created.
            if (!file_exists($footnotesFilePath)) {
                // Fallback: check for an alternate filename.
                $alternatePath = resource_path("markdown/{$book}/main-text-footnotes.json");
                if (file_exists($alternatePath)) {
                    Log::warning("Using alternate footnotes file: {$alternatePath}");
                    if (rename($alternatePath, $footnotesFilePath)) {
                        Log::info("Renamed file to: {$footnotesFilePath}");
                    } else {
                        Log::error("Failed to rename file: {$alternatePath}");
                        return response()->json([
                            'success' => false,
                            'message' => 'Footnotes file not created'
                        ], 500);
                    }
                } else {
                    Log::error("❌ Footnotes file not created at: {$footnotesFilePath}");
                    // Log directory contents for debugging.
                    $dir = dirname($footnotesFilePath);
                    $files = scandir($dir);
                    Log::info("Directory contents of {$dir}:", $files);
                    return response()->json([
                        'success' => false,
                        'message' => 'Footnotes file not created'
                    ], 500);
                }
            } else {
                $newFootnotesTime = filemtime($footnotesFilePath);
                Log::info("✅ Footnotes file updated at: " .
                    date('Y-m-d H:i:s', $newFootnotesTime));
            }
        }

        return response()->json([
            'success' => true,
            'message' => 'Footnotes refreshed.'
        ]);
    }
}
