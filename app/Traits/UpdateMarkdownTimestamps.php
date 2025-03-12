<?php
/*
|------------------------------------------------------------------
| Read Me
|------------------------------------------------------------------
| 
| Udates the footnotes, table of contents (TOC) and update-time data in 
| different .json files. This:
| - syncs the footnotes and table of contents data 
| - ensures that the latest files are used on page load

| This triggers data re-generation **whenever necessary**. 
| It doesn't matter, for example, if a user goes off to obsidian or some external md editor. As long as that file remains or is put back in the right hyperlit.io/user/markdown folder, then the footnotes will be generated at some point along the process. This can happen on page load on front end, or on any update, for example: creating or removing a highlight, hypercite, or markdown text. 
| This is true, in any case, for the TOC and footnotes. 
| *While it is true **now** for a user's own highlights and hypercites, it will be altogether more difficult to maintain this backup-processing logic for multi-user public highlights. Although, it might be resolvable using my proposed data-base system.*

| 1. File Paths:
|   - main-text.md: Source Markdown file
|   - main-text-footnotes.json: Footnotes and headings extracted from markdown 
|   - latest_update.json: Timestamps of the latest updates
|   - nodeChunks.json: Markdown divided into numbered chunks of nodes and lines.

| 2. Footnotes Generation:
|   - Checks if footnotes need regeneration:
|     * If footnotes file doesn't exist
|     * If Markdown file was modified after the footnotes file
|   - Executes a Python script to extract footnotes from the Markdown
|   - Ensures the footnotes file is created successfully

| 3. Node Chunks Generation:
|   - Generates/updates nodeChunks.json if:
|     * The file doesn't exist
|     * The Markdown file was modified after the nodeChunks file
|   - Parses the Markdown content into chunks
|   - Writes the chunks to nodeChunks.json

| 4. Timestamp Updates:
|   - Creates an array with current and file modification timestamps
|   - Writes this data to latest_update.json for frontend use

| 5. Return Response:
|   - Returns success status and timestamps
|   - Returns error status and message if any file is missing

| This function ensures that auxiliary files are only updated when necessary,
| optimizing performance by avoiding redundant operations.
|------------------------------------------------------------------
*/

namespace App\Traits;

use Illuminate\Support\Facades\Log;

trait UpdateMarkdownTimestamps
{
    public function updateLatestMarkdownTimestamp($book)
    {
        $markdownFilePath = resource_path("markdown/{$book}/main-text.md");
        $highlightFilePath= resource_path("markdown/{$book}/hyperlights-display.md");
        $footnotesFilePath = resource_path("markdown/{$book}/main-text-footnotes.json");
        $timestampFilePath = resource_path("markdown/{$book}/latest_update.json");
        $nodeChunksPath    = resource_path("markdown/{$book}/nodeChunks.json");
        $highlightChunksPath = resource_path("markdown/{$book}/highlightChunks.json");

        // Check last modified times
        $markdownLastModified = filemtime($markdownFilePath);
        $footnotesLastModified = file_exists($footnotesFilePath) ? filemtime($footnotesFilePath) : null;
        $highlightsLastModified = file_exists($highlightFilePath) ? filemtime($highlightFilePath) : null;

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

        // Generate highlightChunks.json if needed
        if (!file_exists($highlightChunksPath) || filemtime($highlightChunksPath) < $markdownLastModified) {
            Log::info("📑 Generating nodeChunks.json for: {$book}");

            $highlightContent = file_get_contents($highlightFilePath);
            $highlightChunks = $this->parseMarkdownIntoChunks($highlightContent);

            file_put_contents($highlightChunksPath, json_encode($highlightChunks, JSON_PRETTY_PRINT));
            Log::info("✅ highlightChunks.json updated for {$book}");
        } else {
            Log::info("✅ highlightChunks.json is already up to date for {$book}");
        }

        // Grab nodeChunks last modified (if available)
        $nodeChunksLastModified = file_exists($nodeChunksPath)
            ? filemtime($nodeChunksPath)
            : null;

        // Grab highlightChunks last modified (if available)
        $highlightChunksLastModified = file_exists($highlightChunksPath)
            ? filemtime($highlightChunksPath)
            : null;


        // Save updated timestamp for front-end
        $latestUpdateData = [
            'updated_at'            => time() * 1000,  // ms
            'markdownLastModified'  => $markdownLastModified,
            'footnotesLastModified' => $footnotesLastModified,
            'nodeChunksLastModified'=> $nodeChunksLastModified,
            'highlightChunksLastModified'=> $highlightChunksLastModified
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
            'nodeChunksLastModified'=> $nodeChunksLastModified,
            'highlightChunksLastModified'=> $highlightChunksLastModified
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
        $currentStartLine = 1;

        foreach ($lines as $i => $line) {
            $lineNumber = $i + 1;
            $block = $this->parseLineIntoBlock($line, $lineNumber);

            if ($block) {
                $currentChunk[] = $block;

                if (count($currentChunk) >= 50) {
                    $chunks[] = [
                        'chunk_id' => $chunkId,
                        'start_line' => $currentStartLine,
                        'end_line' => $lineNumber,
                        'blocks' => $currentChunk
                    ];
                    $chunkId++;
                    $currentChunk = [];
                    $currentStartLine = $lineNumber + 1;
                }
            }
        }

        if (!empty($currentChunk)) {
            $chunks[] = [
                'chunk_id' => $chunkId,
                'start_line' => $currentStartLine,
                'end_line' => $lineNumber,
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

