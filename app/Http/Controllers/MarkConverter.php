<?php

namespace App\Http\Controllers;

use League\HTMLToMarkdown\Converter\ConverterInterface;
use League\HTMLToMarkdown\ElementInterface;

class MarkConverter implements ConverterInterface
{
    public function convert(ElementInterface $element): string
    {
        // Your conversion logic here
        $content = $element->getChildrenAsString();
        return '<mark>' . $content . '</mark>';
    }

    public function getSupportedTags(): array
    {
        return ['mark'];
    }
}
