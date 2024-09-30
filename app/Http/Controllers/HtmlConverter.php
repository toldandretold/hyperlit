<?php

namespace App\Http\Controllers;

use League\HTMLToMarkdown\HtmlConverter;
use League\HTMLToMarkdown\Converter\ConverterInterface;

class CustomHeadingConverter implements ConverterInterface
{
    public function convert(\DOMNode $node)
    {
        $level = intval(substr($node->nodeName, 1)); // Extract the number from h1, h2, etc.
        $hashes = str_repeat('#', $level);
        $content = trim($node->textContent);

        return "{$hashes} {$content} {$hashes}\n\n";  // Use `# Title #` format
    }

    public function getSupportedTags()
    {
        return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']; // Handle all heading levels
    }
}
