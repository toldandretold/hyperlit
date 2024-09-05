<?php

namespace App\Http\Controllers;

use Illuminate\Support\Str;
use DOMDocument;
use DOMXPath;

class HtmlContentExtractor
{
    public static function extractHtmlContentFromXPath($book, $startXPath, $endXPath)
    {
        \Log::info("Starting extractHtmlContentFromXPath for book: {$book}");
        \Log::info("Start XPath: {$startXPath}, End XPath: {$endXPath}");

        // Ensure the book is set before doing anything
        if (empty($book)) {
            throw new \Exception('Book identifier must be provided.');
        }

        // Define the path to the saved HTML file
        $htmlFilePath = resource_path("markdown/{$book}/main-text.html");
        \Log::info("Loading HTML file from path: {$htmlFilePath}");

        if (!file_exists($htmlFilePath)) {
            \Log::error("HTML file for book '{$book}' not found.");
            throw new \Exception("HTML file for book '{$book}' not found.");
        }

        // Load the HTML content into a DOMDocument
        $dom = new DOMDocument();
        @$dom->loadHTML(file_get_contents($htmlFilePath)); // Suppress errors/warnings from malformed HTML
        \Log::info("HTML content loaded successfully.");

        // Create a DOMXPath instance
        $xpath = new DOMXPath($dom);

        // Log the loaded DOM to inspect its structure
        $domString = $dom->saveHTML();
        \Log::info("Loaded DOM structure: " . substr($domString, 0, 300) . "...");

        // Normalize the XPath to account for the additional HTML and BODY tags
        if (strpos($startXPath, '/html/body/div') === false) {
            $startXPath = '/html/body/div[1]' . $startXPath;
        }
        if (strpos($endXPath, '/html/body/div') === false) {
            $endXPath = '/html/body/div[1]' . $endXPath;
        }
        \Log::info("Normalized Start XPath: {$startXPath}, End XPath: {$endXPath}");

        // Locate the start and end nodes based on XPath
        \Log::info("Querying DOM for start node: {$startXPath}");
        $startNode = $xpath->query($startXPath)->item(0);

        \Log::info("Querying DOM for end node: {$endXPath}");
        $endNode = $xpath->query($endXPath)->item(0);

        if (!$startNode || !$endNode) {
            \Log::error("Could not find start or end nodes based on the provided XPath.");
            \Log::info("Full DOM structure for debugging: " . $dom->saveHTML()); // Log the full DOM structure for debugging
            throw new \Exception("Could not find start or end nodes based on the provided XPath.");
        }

        // If start and end nodes are the same, return the content of the single node
        if ($startNode->isSameNode($endNode)) {
            \Log::info("Start and end nodes are the same, extracting content within this node.");
            $nodeContent = $dom->saveHTML($startNode);
            \Log::info("Extracted content: " . substr($nodeContent, 0, 100) . "..."); // Log partial content
            return $nodeContent;
        }

        // If they are not the same, extract the HTML between the start and end nodes
        \Log::info("Start and end nodes are different, extracting content between nodes.");
        $extractedHtml = self::getHtmlBetweenNodes($dom, $startNode, $endNode);
        \Log::info("Extracted content: " . substr($extractedHtml, 0, 100) . "..."); // Log partial content

        return $extractedHtml;
    }

    private static function getHtmlBetweenNodes($dom, $startNode, $endNode)
    {
        $currentNode = $startNode;
        $htmlContent = '';

        while ($currentNode) {
            $htmlContent .= $dom->saveHTML($currentNode);

            if ($currentNode->isSameNode($endNode)) {
                break;
            }

            $currentNode = $currentNode->nextSibling;
        }

        return $htmlContent;
    }
}
