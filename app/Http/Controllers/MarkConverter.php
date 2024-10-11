<?php

namespace App\Http\Controllers;

use League\HTMLToMarkdown\Converter\ConverterInterface;
use League\HTMLToMarkdown\ElementInterface;

class MarkConverter implements ConverterInterface
{
    // Corrected convert method to match ConverterInterface
    public function convert(ElementInterface $element): string
    {
        // Handle the <mark> tag conversion without duplicating it
        return '<mark class="' . $element->getAttribute('class') . '" id="' . $element->getAttribute('id') . '">' . $element->getValue() . '</mark>';
    }

    public function getSupportedTags(): array
    {
        return ['mark'];
    }
}
