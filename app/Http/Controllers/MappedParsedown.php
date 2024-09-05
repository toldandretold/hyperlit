<?php

namespace App\Http\Controllers;

use Parsedown;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

class MappedParsedown extends Parsedown
{
    protected $mapping = [];
    protected $originalText;
    protected $htmlPosition = 0; // Manual tracking of HTML position
    protected $book; // Store the book identifier
    protected $xpathStack = []; // Stack to keep track of the current XPath
    protected $currentDepth = 0; // Track the current depth of the DOM

    // Method to set the book identifier
    public function setBook($book)
    {
        \Log::info('MappedParsedown setBook called with book: ' . ($book ?: 'No book provided'));
        $this->book = $book;
    }

    // Override the text method to include clearing old mappings and saving HTML
    public function text($text)
    {
        \Log::info('MappedParsedown text method called');
        \Log::info("Original markdown text: {$text}");

        // Ensure the book is set before proceeding
        if (empty($this->book)) {
            \Log::error('Book identifier is not set before processing the text.');
            throw new \Exception('Book identifier must be set before calling text.');
        }

        // Clear old mappings for the book
        $this->clearOldMappings($this->book);

        // Reset mapping and position trackers for each conversion
        $this->mapping = [];
        $this->originalText = $text;
        $this->htmlPosition = 0;
        $this->xpathStack = [];
        $this->currentDepth = 0;

        // Convert markdown to HTML, wrap it in a <div> tag
        $html = '<div>' . parent::text($text) . '</div>';

        // Save the HTML content to a file in the book folder
        $htmlFilePath = resource_path("markdown/{$this->book}/main-text.html");
        File::put($htmlFilePath, $html);

        \Log::info('Mapping data:', $this->mapping);

        return [
            'html' => $html,
            'mapping' => $this->mapping,
        ];
    }

    // Method to clear old mappings for the specified book
    protected function clearOldMappings($book)
    {
        \Log::info("Attempting to clear old mappings for book: {$book}");
        DB::table('text_mappings')->where('book', $book)->delete();
        \Log::info("Old mappings for book: {$book} have been cleared.");
    }

   protected function element(array $Element)
{
    $text = $Element['text'] ?? '';

    if (is_array($text)) {
        $text = implode('', array_map(function ($item) {
            return is_array($item) ? $item['text'] ?? '' : $item;
        }, $text));
    }

    $text = trim($text);

    // Log the text being processed
    \Log::info("Processing element text: '{$text}'");

    $startPositionMarkdown = $this->findUniqueStartPosition($this->originalText, $text);
    $endPositionMarkdown = $startPositionMarkdown !== false ? $startPositionMarkdown + strlen($text) : null;

    if ($startPositionMarkdown === false) {
        \Log::warning("Element text '{$text}' not found in original markdown.");
    } else {
        \Log::info("Mapping element text: {$text}, Start Position: {$startPositionMarkdown}, End Position: {$endPositionMarkdown}");

        $contextHash = hash('sha256', $text . $startPositionMarkdown);
        $mappingId = Str::uuid()->toString();

        $htmlText = $this->elementToHtml($Element);
        $startPositionHtml = $this->htmlPosition;
        $endPositionHtml = $startPositionHtml + strlen($htmlText);

        // Generate XPath expression with refined hierarchy tracking
        $xpath = $this->generateXPath($Element);

        // Update manual HTML position
        $this->htmlPosition = $endPositionHtml;

        $this->mapping[] = [
            'markdown' => $text,
            'start_position_markdown' => $startPositionMarkdown,
            'end_position_markdown' => $endPositionMarkdown,
            'html' => $htmlText,
            'start_position_html' => $startPositionHtml,
            'end_position_html' => $endPositionHtml,
            'context_hash' => $contextHash,
            'mapping_id' => $mappingId,
            'xpath' => $xpath, // Add the XPath expression to the mapping
        ];
    }

    // Log the stack after processing
    \Log::info('Current XPath Stack after processing: ' . json_encode($this->xpathStack));

    return parent::element($Element);
}

protected function generateXPath(array $Element)
{
    $tag = $Element['name'];
    $currentLevel = count($this->xpathStack);

    if ($currentLevel === 0) {
        // If the stack is empty, start with the first element
        $xpath = '/' . $tag . '[1]';
        $this->xpathStack[] = ['tag' => $tag, 'xpath' => $xpath, 'level' => 1];
    } else {
        $lastElement = end($this->xpathStack);

        if ($lastElement['tag'] === $tag && $lastElement['level'] === $currentLevel) {
            // If the last element is a sibling at the same level, increment the index
            $siblingIndex = intval(substr($lastElement['xpath'], strrpos($lastElement['xpath'], '[') + 1, -1)) + 1;
            $xpath = '/' . $tag . '[' . $siblingIndex . ']';
            $this->xpathStack[$currentLevel - 1] = ['tag' => $tag, 'xpath' => $xpath, 'level' => $currentLevel];
        } else {
            // Otherwise, this is a child element or a new tag type
            $xpath = $lastElement['xpath'] . '/' . $tag . '[1]';
            $this->xpathStack[] = ['tag' => $tag, 'xpath' => $xpath, 'level' => $currentLevel + 1];
        }
    }

    \Log::info('Generated XPath: ' . $xpath);
    \Log::info('Current XPath Stack after processing: ' . json_encode($this->xpathStack));
    return $xpath;
}



    protected function findUniqueStartPosition($originalText, $text)
    {
        $offset = 0;
        while (($position = strpos($originalText, $text, $offset)) !== false) {
            if (!in_array($position, array_column($this->mapping, 'start_position_markdown'))) {
                return $position;
            }
            $offset = $position + strlen($text);
        }
        return false;
    }

    protected function elementToHtml(array $Element)
    {
        $tag = $Element['name'];
        $text = $this->convertArrayToText($Element['text'] ?? '');
        $attributes = '';

        if (!empty($Element['attributes'])) {
            foreach ($Element['attributes'] as $name => $value) {
                $attributes .= " {$name}=\"{$value}\"";
            }
        }

        return "<{$tag}{$attributes}>{$text}</{$tag}>";
    }

    protected function convertArrayToText($input)
    {
        if (is_array($input)) {
            return implode('', array_map([$this, 'convertArrayToText'], $input));
        }
        return $input;
    }
}
