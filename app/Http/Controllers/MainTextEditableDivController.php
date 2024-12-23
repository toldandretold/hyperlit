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

    // Log the raw input to inspect the actual data sent from the frontend
    Log::info('Raw input received:', $request->all());
    
    $validatedData = $request->validate([
        'book' => 'required|string',
        'updates' => 'required|array',
        'updates.*.id' => 'required|string',
        'updates.*.action' => 'required|string', // 'update' or 'delete'
        'updates.*.html' => 'nullable|string',   // Only required for 'update' actions
    ]);

    $book = $validatedData['book'];
    $updates = $validatedData['updates'];
    $filePath = resource_path("markdown/{$book}/main-text.md");

    // Load Markdown lines
    $markdownLines = file($filePath, FILE_IGNORE_NEW_LINES);
    Log::info("Loaded Markdown file with " . count($markdownLines) . " lines.");

    // Process updates in reverse order to avoid offset issues
    usort($updates, function ($a, $b) {
        return strcmp($b['id'], $a['id']);
    });

    foreach ($updates as $update) {
        $blockId = $update['id'];
        $action = $update['action'];

        if (preg_match('/^(\d+)([a-z]*)$/', $blockId, $matches)) {
            $lineNumber = (int)$matches[1] - 1; // 1-based to 0-based index
            $letter = $matches[2];
            $adjustedLineNumber = $lineNumber;

            if ($action === 'update') {
                $htmlContent = $update['html'];
                $markdownContent = $this->convertHtmlToMarkdown($htmlContent);

                if ($letter) {
                    // Insert new paragraph
                    array_splice($markdownLines, $adjustedLineNumber + 1, 0, [$markdownContent, ""]);
                    Log::info("Inserted new line for ID {$blockId} at adjusted line " . ($adjustedLineNumber + 1) . ".");
                } else {
                    // Replace existing line
                    $markdownLines[$adjustedLineNumber] = $markdownContent;
                    Log::info("Replaced line for ID {$blockId} at adjusted line {$adjustedLineNumber}.");
                }
            } elseif ($action === 'delete') {
                if (isset($markdownLines[$adjustedLineNumber])) {
                    // Remove blank line before the target line, if present
                    if ($adjustedLineNumber > 0 && trim($markdownLines[$adjustedLineNumber - 1]) === '') {
                        array_splice($markdownLines, $adjustedLineNumber - 1, 2);
                        Log::info("Deleted line {$blockId} and preceding blank line at adjusted line " . ($adjustedLineNumber - 1) . ".");
                    } else {
                        array_splice($markdownLines, $adjustedLineNumber, 1);
                        Log::info("Deleted line {$blockId} at adjusted line {$adjustedLineNumber}.");
                    }
                } else {
                    Log::warning("Line {$blockId} not found for deletion.");
                }
            }
        } else {
            Log::warning("Invalid block ID format: {$blockId}");
        }
    }

    // Save updated Markdown file
    file_put_contents($filePath, implode(PHP_EOL, $markdownLines) . PHP_EOL);
    Log::info("Successfully updated Markdown file at: {$filePath}");

    return response()->json(['success' => true, 'message' => 'Content updated successfully.']);
}









private function convertHtmlToMarkdown($html)
{
    // Wrap HTML in a dummy div for processing
    $html = '<div>' . $html . '</div>';
    $doc = new \DOMDocument();
    @$doc->loadHTML(mb_convert_encoding($html, 'HTML-ENTITIES', 'UTF-8'));

    $markdownContent = '';

    foreach ($doc->getElementsByTagName('div')->item(0)->childNodes as $node) {
        if ($node->nodeType === XML_TEXT_NODE) {
            // Preserve plain text
            $markdownContent .= htmlspecialchars($node->nodeValue, ENT_QUOTES | ENT_HTML5);
        } elseif ($node->nodeType === XML_ELEMENT_NODE) {
            // Preserve inline HTML elements like <mark>, <u>, <a>, etc.
            if (in_array($node->nodeName, ['mark', 'u', 'a'])) {
                $markdownContent .= $doc->saveHTML($node);
            } else {
                // Handle block-level elements like <p>, <h1>, etc.
                $markdownContent .= htmlspecialchars($node->textContent, ENT_QUOTES | ENT_HTML5);
            }
        }
    }

    return trim($markdownContent);
}


    
}
