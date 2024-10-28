<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\File;
use ParsedownExtra; // ParsedownExtra is imported here as a class, not a trait
use Illuminate\Support\Facades\DB;
use League\HTMLToMarkdown\HtmlConverter;
use League\HTMLToMarkdown\ElementInterface;
use App\Http\Controllers\MarkConverter;
use App\Http\Controllers\AnchorConverter;
use App\Http\Controllers\CustomHeaderConverter;
use DOMDocument;

class ConversionController extends Controller
{
    protected $book;

    public function __construct($book = null)
    {
        $this->book = $book;
    }

    // Method to set the book identifier
    public function setBook($book)
    {
        $this->book = $book;
    }

    public function markdownToHtml()
    {
        // Ensure the book is set
        if (empty($this->book)) {
            throw new \Exception('Book identifier must be set before converting markdown to HTML.');
        }

        // Read the markdown content from the file
        $markdownFilePath = resource_path("markdown/{$this->book}/main-text.md");
        if (!File::exists($markdownFilePath)) {
            throw new \Exception("Markdown file does not exist at path: {$markdownFilePath}");
        }
        $markdown = File::get($markdownFilePath);

        // Create a new instance of ParsedownExtra
        $converter = new ParsedownExtra(); // Instantiate ParsedownExtra class

        // Convert markdown to HTML using Parsedown Extra
        $html = $converter->text($markdown);

        // Save the HTML content to a file
        $htmlFilePath = resource_path("markdown/{$this->book}/main-text.html");
        File::put($htmlFilePath, $html);

        // Update positions
        $this->updateGlobalPositions($this->book);

        return $html;
    }

    public function htmlToMarkdown()
    {
        // Ensure the book is set
        if (empty($this->book)) {
            throw new \Exception('Book identifier must be set before converting HTML to markdown.');
        }

        // Read the HTML content from the file
        $htmlFilePath = resource_path("markdown/{$this->book}/main-text.html");
        if (!File::exists($htmlFilePath)) {
            throw new \Exception("HTML file does not exist at path: {$htmlFilePath}");
        }
        $htmlContent = File::get($htmlFilePath);

        // Configure the HTML to Markdown converter
        $converter = new HtmlConverter([]);

        // Add custom handlers to preserve <mark>, <a>, and now <h1>-<h6> tags
        $converter->getEnvironment()->addConverter(new MarkConverter());
        $converter->getEnvironment()->addConverter(new AnchorConverter());
        $converter->getEnvironment()->addConverter(new CustomHeaderConverter()); // Add the custom header converter

 
        // Convert HTML to Markdown
        $markdown = $converter->convert($htmlContent);

        // Save the markdown content to a file
        $markdownFilePath = resource_path("markdown/{$this->book}/main-text.md");
        File::put($markdownFilePath, $markdown);

        // Update positions after conversion
        $this->updateGlobalPositions($this->book);

        return $markdown;
    }

    // Method to extract <mark> elements and map them to highlight IDs
    protected function extractMarkPositions(DOMDocument $dom)
    {
        $markMappings = [];
        $markElements = $dom->getElementsByTagName('mark');
        $position = 1;

        foreach ($markElements as $markElement) {
            if ($markElement->hasAttribute('id')) {
                $highlightId = $markElement->getAttribute('id');
                $markMappings[] = [
                    'highlight_id' => $highlightId,
                    'global_position' => $position
                ];
                $position++;
            }
        }

        return $markMappings;
    }

    // Refactored method to update global positions for <mark> elements
    public function updateGlobalPositions($book)
    {
        if (empty($book)) {
            throw new \Exception('Book identifier must be set.');
        }

        // Read the HTML content from the file
        $htmlFilePath = resource_path("markdown/{$book}/main-text.html");
        if (!File::exists($htmlFilePath)) {
            throw new \Exception("HTML file does not exist at path: {$htmlFilePath}");
        }
        $htmlContent = File::get($htmlFilePath);

        // Load the HTML content into a DOMDocument object
        $dom = new DOMDocument();
        @$dom->loadHTML($htmlContent);

        // Extract the mark positions and highlight ids
        $markMappings = $this->extractMarkPositions($dom);

        // Update the database with the highlight_id and global_position mappings
        foreach ($markMappings as $mapping) {
            DB::table('highlights')
                ->where('highlight_id', $mapping['highlight_id'])
                ->update(['global_position' => $mapping['global_position']]);
        }

        \Log::info("Global positions updated for book: {$book}");
    }
}
