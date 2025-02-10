<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class MainTextEditableDivController extends Controller
{
    public function showEditableText($book = 'default-book')
    {
        return view('hyperlighting_div', ['book' => $book]);
    }

public function saveEditedContent(Request $request)
{
    Log::info('Raw input received:', $request->all());

    $validatedData = $request->validate([
        'book' => 'required|string',
        'updates' => 'required|array',
        'updates.*.id' => 'required|string',
        'updates.*.action' => 'required|string',
        'updates.*.html' => 'nullable|string',
    ]);

    $book = $validatedData['book'];
    $updates = $validatedData['updates'];
    $markdownFilePath = resource_path("markdown/{$book}/main-text.md");

    $markdownLines = file($markdownFilePath, FILE_IGNORE_NEW_LINES);
    Log::info("Loaded Markdown file with " . count($markdownLines) . " lines.");

    // Sort updates by line ID in reverse order.
    usort($updates, function ($a, $b) {
        return strcmp($b['id'], $a['id']);
    });

    foreach ($updates as $update) {
        $blockId = $update['id'];
        $action = $update['action'];

        if (!$blockId) {
            Log::warning("Skipping update with null or invalid ID.");
            continue;
        }

        if (preg_match('/^(\d+)([a-z]*)$/', $blockId, $matches)) {
            $this->processNumericIdUpdate($matches, $action, $update, $markdownLines);
        } else {
            $this->processComplexIdUpdate($blockId, $action, $update, $markdownLines);
        }
    }

    // Save updated Markdown file.
    file_put_contents($markdownFilePath, implode(PHP_EOL, $markdownLines) . PHP_EOL);
    Log::info("Successfully updated Markdown file at: {$markdownFilePath}");

    // ✅ Call updateLatestMarkdownTimestamp(), which now returns a JSON response
    return $this->updateLatestMarkdownTimestamp($book);
}

/**
 * Updates timestamps for markdown and footnotes, and also generates nodeChunks.json
 */
private function updateLatestMarkdownTimestamp($book)
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
        $pythonBin = "/usr/local/bin/python3";
        $pythonScriptPath = "/app/Python/footnote-jason.py";
        
        $command = escapeshellcmd("{$pythonBin} {$pythonScriptPath} {$markdownFilePath} 2>&1");
        Log::info("🚀 Running command: {$command}");

        $output = shell_exec($command);
        if ($output === null) {
            Log::error("❌ Python script execution failed (null output).");
        } else {
            Log::info("🔄 Python Footnotes Update Output:\n" . $output);
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

    // Return JSON response with the new field
    return response()->json([
        'success'               => true,
        'message'               => 'Markdown, footnotes, and nodeChunks updated.',
        'markdownLastModified'  => $markdownLastModified,
        'footnotesLastModified' => $footnotesLastModified,
        'nodeChunksLastModified'=> $nodeChunksLastModified
            ? $nodeChunksLastModified * 1000
            : null
    ]);
}




   
private function updateMarkdownChunks($book)
{
    $markdownFilePath = resource_path("markdown/{$book}/main-text.md");
    $chunksJsonPath = resource_path("markdown/{$book}/nodeChunks.json");

    // ✅ Ensure the Markdown file exists
    if (!file_exists($markdownFilePath)) {
        Log::error("❌ Markdown file missing: {$markdownFilePath}");
        return response()->json(['error' => 'Markdown file not found'], 404);
    }

    $markdownLastModified = filemtime($markdownFilePath);
    $chunksLastModified = file_exists($chunksJsonPath) ? filemtime($chunksJsonPath) : 0;

    // ✅ Skip processing if chunks are up-to-date
    if ($chunksLastModified >= $markdownLastModified) {
        Log::info("✅ nodeChunks.json is up-to-date for {$book}");
        return response()->json(['success' => true, 'message' => 'Chunks already up-to-date']);
    }

    // ✅ Read Markdown file
    $markdown = file_get_contents($markdownFilePath);

    // ✅ Process Markdown into chunks
    $chunks = $this->parseMarkdownIntoChunks($markdown);

    // ✅ Save chunks as JSON
    file_put_contents($chunksJsonPath, json_encode($chunks, JSON_PRETTY_PRINT));
    Log::info("✅ nodeChunks.json updated for {$book}");

    return response()->json([
        'success' => true,
        'message' => 'Markdown parsed into chunks and saved',
        'chunksLastModified' => filemtime($chunksJsonPath),
    ]);
}

/**
 * Parses Markdown into structured chunks for efficient frontend processing.
 */
/**
 * Parses Markdown into an array of "chunks" for efficient use on the frontend.
 */
private function parseMarkdownIntoChunks(string $markdown)
{
    $lines = explode("\n", $markdown);
    $chunks = [];
    $currentChunk = [];
    $currentChunkId = 0;
    $currentStartLine = 1;

    foreach ($lines as $i => $rawLine) {
        $trimmed = trim($rawLine);
        $adjustedLineNumber = $i + 1;
        $block = null;

        // Heading detection
        if (preg_match('/^#{1,5}\s/', $trimmed)) {
            $level = strlen(explode(' ', $trimmed, 2)[0]); // count '#' in the first token
            $content = preg_replace('/^#+\s*/', '', $trimmed);
            $block = [
                'type'      => 'heading',
                'level'     => $level,
                'startLine' => $adjustedLineNumber,
                'content'   => $content,
            ];
        }
        // Blockquote detection
        elseif (str_starts_with($trimmed, '>')) {
            $content = preg_replace('/^>\s?/', '', $trimmed);
            $block = [
                'type'      => 'blockquote',
                'startLine' => $adjustedLineNumber,
                'content'   => $content
            ];
        }
        // Image detection
        elseif (preg_match('/^!\[.*\]\(.*\)$/', $trimmed)) {
            preg_match('/^!\[(.*)\]\((.*)\)$/', $trimmed, $matches);
            $block = [
                'type'      => 'image',
                'startLine' => $adjustedLineNumber,
                'altText'   => $matches[1] ?? '',
                'imageUrl'  => $matches[2] ?? '',
            ];
        }
        // Fallback paragraph
        elseif (!empty($trimmed)) {
            $block = [
                'type'      => 'paragraph',
                'startLine' => $adjustedLineNumber,
                'content'   => $trimmed,
            ];
        }

        // If we identified a block, push it into current chunk
        if ($block) {
            $currentChunk[] = $block;
        }

        // Once chunk reaches size 50 or is at the end, push it
        if (count($currentChunk) >= 50 || $i === count($lines) - 1) {
            $chunks[] = [
                'chunk_id'   => $currentChunkId,
                'start_line' => $currentStartLine,
                'end_line'   => $adjustedLineNumber,
                'blocks'     => $currentChunk,
            ];
            $currentChunk = [];
            $currentChunkId++;
            $currentStartLine = $adjustedLineNumber + 1;
        }
    }

    return $chunks;
}



    private function processNumericIdUpdate($matches, $action, $update, &$markdownLines)
        {
            try {
                $lineNumber = (int)$matches[1] - 1; // Convert 1-based ID to 0-based index
                $letter = $matches[2];

                if ($action === 'update') {
                    Log::info("Calling convertHtmlToMarkdown for line: {$lineNumber}, ID: {$matches[0]}");
                    $htmlContent = $update['html'];
                    $markdownContent = $this->convertHtmlToMarkdown($htmlContent);
                    Log::info("Markdown conversion result for line {$lineNumber}: " . $markdownContent);

                    if ($letter) {
                        $this->insertNewLineWithLetter($lineNumber, $markdownContent, $markdownLines);
                    } else {
                        $this->updateExistingLine($lineNumber, $markdownContent, $markdownLines);
                    }
                } elseif ($action === 'delete') {
                    $this->deleteLine($lineNumber, $markdownLines);
                }
            } catch (\Exception $e) {
                Log::error("Error in processNumericIdUpdate: " . $e->getMessage());
                throw $e;
            }
        }

private function processComplexIdUpdate($blockId, $action, $update, &$markdownLines)
    {
        if (in_array($action, ['update', 'delete'])) {
            Log::info("Processing complex ID: {$blockId}");

            if ($action === 'update') {
                Log::info("Calling convertHtmlToMarkdown for complex ID: {$blockId}");
                $htmlContent = $update['html'];
                $markdownContent = $this->convertHtmlToMarkdown($htmlContent);
                Log::info("Markdown conversion result for complex ID {$blockId}: " . $markdownContent);
            } elseif ($action === 'delete') {
                Log::info("Delete request for complex ID: {$blockId}");
            }
        } else {
            Log::warning("Unsupported action for complex ID: {$blockId}");
        }
    }


    private function insertNewLineWithLetter($lineNumber, $markdownContent, &$markdownLines)
    {
        $insertIndex = $lineNumber + 1;

        $newLines = [];
        if ($insertIndex > 0 && trim($markdownLines[$insertIndex - 1]) !== '') {
            $newLines[] = ''; // Add a blank line before if missing
        }

        $newLines[] = $markdownContent;

        if ($insertIndex < count($markdownLines) && trim($markdownLines[$insertIndex]) === '') {
            // Skip adding another blank line (already exists)
        } else {
            $newLines[] = ''; // Ensure exactly one blank line after
        }

        array_splice($markdownLines, $insertIndex, 0, $newLines);
        Log::info("Inserted new line for lettered ID at line " . ($insertIndex + 1) . ".");
    }

    private function updateExistingLine($lineNumber, $markdownContent, &$markdownLines)
    {
        if (isset($markdownLines[$lineNumber])) {
            $markdownLines[$lineNumber] = $markdownContent;

            if ($lineNumber + 1 < count($markdownLines) && trim($markdownLines[$lineNumber + 1]) === '') {
                // Skip adding another blank line (already exists)
            } else {
                array_splice($markdownLines, $lineNumber + 1, 0, ['']);
            }

            Log::info("Updated line at line {$lineNumber}.");
        } else {
            Log::warning("Line not found for update at line {$lineNumber}.");
        }
    }

    private function deleteLine($lineNumber, &$markdownLines)
    {
        if (isset($markdownLines[$lineNumber])) {
            array_splice($markdownLines, $lineNumber, 1);

            while ($lineNumber < count($markdownLines) && trim($markdownLines[$lineNumber]) === '') {
                array_splice($markdownLines, $lineNumber, 1);
            }

            if ($lineNumber > 0 && trim($markdownLines[$lineNumber - 1]) !== '') {
                array_splice($markdownLines, $lineNumber, 0, ['']);
            }

            Log::info("Deleted line at line {$lineNumber}.");
        } else {
            Log::warning("Line not found for deletion at line {$lineNumber}.");
        }
    }

private function convertHtmlToMarkdown($html)
{
    try {
        Log::info("Converting HTML to Markdown: " . $html);

        $html = '<div>' . $html . '</div>';
        $doc = new \DOMDocument();
        @$doc->loadHTML(mb_convert_encoding($html, 'HTML-ENTITIES', 'UTF-8'));

        $markdownContent = '';

        foreach ($doc->getElementsByTagName('div')->item(0)->childNodes as $node) {
            if ($node->nodeType === XML_TEXT_NODE) {
                // Add plain text content directly
                $markdownContent .= $node->nodeValue;
            } elseif ($node->nodeType === XML_ELEMENT_NODE) {
                // Handle inline tags
                if (in_array($node->nodeName, ['b', 'strong'])) {
                    $markdownContent .= "**" . $node->textContent . "**";
                } elseif (in_array($node->nodeName, ['i', 'em'])) {
                    $markdownContent .= "*" . $node->textContent . "*";
                } elseif ($node->nodeName === 'a') {
                    // Preserve <a> tags with all attributes
                    $markdownContent .= $this->preserveElementWithAttributes($node);
                } elseif ($node->nodeName === 'mark') {
                    // Preserve <mark> tags with all attributes
                    $markdownContent .= $this->preserveElementWithAttributes($node);
                } elseif ($node->nodeName === 'p') {
                    // Process <p> block recursively
                    $markdownContent .= "\n\n" . $this->processInlineElements($node) . "\n\n";
                } else {
                    // Fallback for other tags
                    $markdownContent .= $node->textContent;
                }
            }
        }

        $markdownContent = trim($markdownContent);
        Log::info("Converted Markdown: " . $markdownContent);
        return $markdownContent;
    } catch (\Exception $e) {
        Log::error("Error during Markdown conversion: " . $e->getMessage());
        return ''; // Fallback to an empty string on failure
    }
}

private function processInlineElements($parentNode)
{
    $markdown = '';
    foreach ($parentNode->childNodes as $child) {
        if ($child->nodeType === XML_TEXT_NODE) {
            $markdown .= $child->nodeValue;
        } elseif ($child->nodeType === XML_ELEMENT_NODE) {
            if ($child->nodeName === 'mark') {
                $markdown .= $this->preserveElementWithAttributes($child);
            } elseif ($child->nodeName === 'b' || $child->nodeName === 'strong') {
                $markdown .= "**" . $child->textContent . "**";
            } elseif ($child->nodeName === 'i' || $child->nodeName === 'em') {
                $markdown .= "*" . $child->textContent . "*";
            } elseif ($child->nodeName === 'a') {
                // Preserve <a> tags with all attributes
                $markdown .= $this->preserveElementWithAttributes($child);
            } else {
                $markdown .= $child->textContent;
            }
        }
    }
    return $markdown;
}

private function preserveElementWithAttributes($node)
{
    $tagName = $node->nodeName;
    $attributes = '';

    foreach ($node->attributes as $attribute) {
        $attributes .= ' ' . $attribute->nodeName . '="' . htmlspecialchars($attribute->nodeValue, ENT_QUOTES | ENT_HTML5) . '"';
    }

    return "<{$tagName}{$attributes}>" . $node->textContent . "</{$tagName}>";
}



}
