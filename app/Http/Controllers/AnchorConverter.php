<?php

namespace App\Http\Controllers;

use League\HTMLToMarkdown\Converter\ConverterInterface;
use League\HTMLToMarkdown\ElementInterface;
use League\HTMLToMarkdown\HtmlConverter;

class AnchorConverter implements ConverterInterface
{
    public function convert(ElementInterface $element): string
    {
        $href = $element->getAttribute('href') ?? '';
        $text = $element->getValue();

        return '[' . $text . '](' . $href . ')';
    }

    public function getSupportedTags(): array
    {
        return ['a'];
    }
}
