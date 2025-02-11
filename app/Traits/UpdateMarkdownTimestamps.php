<?php

namespace App\Traits;

use Illuminate\Support\Facades\Log;

trait UpdateMarkdownTimestamps
{
    public function updateLatestMarkdownTimestamp($book)
    {
              $markdownFilePath = resource_path("markdown/{$book}/main-text.md");
        $footnotesFilePath = resource_path("markdown/{$book}/main-text-footnotes.json");
        $timestampFilePath = resource_path("markdown/{$book}/latest_update.json");
        $nodeChunksPath    = resource_path("markdown/{$book}/nodeChunks.json");

        // Check last modified times
        $markdownLastModified = filemtime($markdownFilePath);
        $footnotesLastModified = file_exists($footnotesFilePath) ? filemtime($footnotesFilePath) : null;

        // Regenerate footnotes if needed
        if (!$footnotesLastModified || $markdownLastModified > $footnotesLastModified) {
            Log::info("📝 Markdown updated. Regenerating footnotes for: {$book}");
            
            // Verify markdown file exists
            if (!file_exists($markdownFilePath)) {
                Log::error("❌ Markdown file not found at: {$markdownFilePath}");
                return [
                    'success' => false,
                    'message' => 'Markdown file not found'
                ];
            }

            // Get Python path
            $pythonBin = trim(shell_exec('which python3'));
            if (empty($pythonBin)) {
                $pythonBin = "/usr/local/bin/python3"; // fallback
            }
            Log::info("🐍 Using Python at: {$pythonBin}");

            // Verify Python script exists and is executable
            $pythonScriptPath = base_path("/App/Python/footnote-jason.py");
            if (!file_exists($pythonScriptPath)) {
                Log::error("❌ Python script not found at: {$pythonScriptPath}");
                return [
                    'success' => false,
                    'message' => 'Python script not found'
                ];
            }

            // Ensure script is executable
            chmod($pythonScriptPath, 0755);

            // Build command with proper escaping and full paths
            $escapedMarkdownPath = escapeshellarg($markdownFilePath);
            $escapedScriptPath = escapeshellarg($pythonScriptPath);
            $command = "{$pythonBin} {$escapedScriptPath} {$escapedMarkdownPath} 2>&1";
            
            Log::info("🚀 Executing command: {$command}");

            // Execute command and capture output
            $output = shell_exec($command);
            
            if ($output === null) {
                Log::error("❌ Python script execution failed (null output)");
            } else {
                Log::info("🔄 Python script output: " . $output);
                
                // Verify footnotes file was created
                if (file_exists($footnotesFilePath)) {
                    $newFootnotesTime = filemtime($footnotesFilePath);
                    Log::info("✅ Footnotes file updated at: " . date('Y-m-d H:i:s', $newFootnotesTime));
                } else {
                    Log::error("❌ Footnotes file not created at: {$footnotesFilePath}");
                    // Check if it was created with a different name
                    $dir = dirname($footnotesFilePath);
                    $files = scandir($dir);
                    Log::info("📁 Directory contents of {$dir}:", $files);
                }
            }

            // Refresh footnotes timestamp
            $footnotesLastModified = file_exists($footnotesFilePath)
                ? filemtime($footnotesFilePath)
                : time();
        }

        // Generate nodeChunks.json if needed
        if (!file_exists($nodeChunksPath) || filemtime($nodeChunksPath) < $markdownLastModified) {
            Log::info("📑 Generating nodeChunks.json for: {$book}");

            $markdownContent = file_get_contents($markdownFilePath);
            $chunks = $this->parseMarkdownIntoChunks($markdownContent);

            file_put_contents($nodeChunksPath, json_encode($chunks, JSON_PRETTY_PRINT));
            Log::info("✅ nodeChunks.json updated for {$book}");
        } else {
            Log::info("✅ nodeChunks.json is already up to date for {$book}");
        }

        // Grab nodeChunks last modified (if available)
        $nodeChunksLastModified = file_exists($nodeChunksPath)
            ? filemtime($nodeChunksPath)
            : null;

        // Save updated timestamp for front-end
        $latestUpdateData = [
            'updated_at'            => time() * 1000,  // ms
            'markdownLastModified'  => $markdownLastModified,
            'footnotesLastModified' => $footnotesLastModified,
            'nodeChunksLastModified'=> $nodeChunksLastModified
                ? $nodeChunksLastModified * 1000  // convert to ms if you like
                : null,
        ];

        file_put_contents($timestampFilePath, json_encode($latestUpdateData, JSON_PRETTY_PRINT));
        Log::info("✅ Updated latest_update.json for {$book}");

        return [
            'success'               => true,
            'message'              => 'Markdown, footnotes, and nodeChunks updated.',
            'markdownLastModified'  => $markdownLastModified,
            'footnotesLastModified' => $footnotesLastModified,
            'nodeChunksLastModified'=> $nodeChunksLastModified
                ? $nodeChunksLastModified * 1000
                : null
        ];
    }

    private function parseMarkdownIntoChunks($markdown) 
    {
        $lines = explode("\n", $markdown);
        $chunks = [];
        $currentChunk = [];
        $chunkId = 0;
        $lineNumber = 1;
        $chunkStartLine = 1;

        foreach ($lines as $line) {
            // Start a new chunk every X lines or at headings
            if (count($currentChunk) >= 50 || preg_match('/^#{1,6}\s/', $line)) {
                if (!empty($currentChunk)) {
                    $chunks[] = [
                        'chunk_id' => $chunkId,
                        'start_line' => $chunkStartLine,
                        'end_line' => $lineNumber - 1,
                        'blocks' => $currentChunk
                    ];
                    $chunkId++;
                    $currentChunk = [];
                    $chunkStartLine = $lineNumber;
                }
            }

            // Parse the line into a block
            $block = $this->parseLineIntoBlock($line, $lineNumber);
            if ($block) {
                $currentChunk[] = $block;
            }

            $lineNumber++;
        }

        // Add the last chunk if it's not empty
        if (!empty($currentChunk)) {
            $chunks[] = [
                'chunk_id' => $chunkId,
                'start_line' => $chunkStartLine,
                'end_line' => $lineNumber - 1,
                'blocks' => $currentChunk
            ];
        }

        return $chunks;
    }

    private function parseLineIntoBlock($line, $lineNumber) 
    {
        $line = trim($line);
        if (empty($line)) return null;

        // Check for headings
        if (preg_match('/^(#{1,6})\s+(.+)$/', $line, $matches)) {
            return [
                'type' => 'heading',
                'level' => strlen($matches[1]),
                'content' => $matches[2],
                'startLine' => $lineNumber,
                'lines' => [$line]
            ];
        }

        // Check for blockquotes
        if (preg_match('/^>\s*(.+)$/', $line, $matches)) {
            return [
                'type' => 'blockquote',
                'content' => $matches[1],
                'startLine' => $lineNumber,
                'lines' => [$line]
            ];
        }

        // Check for images
        if (preg_match('/^!\[([^\]]*)\]\(([^)]+)\)$/', $line, $matches)) {
            return [
                'type' => 'image',
                'altText' => $matches[1],
                'imageUrl' => $matches[2],
                'startLine' => $lineNumber,
                'lines' => [$line]
            ];
        }

        // Default to paragraph
        return [
            'type' => 'paragraph',
            'content' => $line,
            'startLine' => $lineNumber,
            'lines' => [$line]
        ];
    }
}

