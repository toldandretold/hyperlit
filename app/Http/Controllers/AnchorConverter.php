<?php

namespace App\Http\Controllers;

use League\HTMLToMarkdown\Converter\ConverterInterface;
use League\HTMLToMarkdown\ElementInterface;

class AnchorConverter implements ConverterInterface
{
    public function convert(ElementInterface $element): string
    {
        // Get common attributes: href, id, and class
        $href = $element->getAttribute('href') ?? '';
        $id = $element->getAttribute('id') ?? '';
        $class = $element->getAttribute('class') ?? '';
        $text = $element->getValue();

        // Build the <a> tag with href, id, and class if they exist
        $anchorTag = '<a href="' . $href . '"';
        if (!empty($id)) {
            $anchorTag .= ' id="' . $id . '"';
        }
        if (!empty($class)) {
            $anchorTag .= ' class="' . $class . '"';
        }
        $anchorTag .= '>';

        // Return the full <a> tag with text and closing tag
        return $anchorTag . $text . '</a>';
    }

    public function getSupportedTags(): array
    {
        return ['a'];
    }
}
