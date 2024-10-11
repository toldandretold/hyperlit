<?php

namespace App\Http\Controllers;

use League\HTMLToMarkdown\Converter\ConverterInterface;
use League\HTMLToMarkdown\ElementInterface;

class CustomHeaderConverter implements ConverterInterface
{
    // Corrected convert method to match ConverterInterface
    public function convert(ElementInterface $element): string
    {
        $level = intval($element->getTagName()[1]); // Get the heading level (1 for h1, 2 for h2, etc.)
        $prefix = str_repeat('#', $level); // Add the appropriate number of hashes

        return $prefix . ' ' . $element->getValue() . PHP_EOL;
    }

    public function getSupportedTags(): array
    {
        return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    }
}
