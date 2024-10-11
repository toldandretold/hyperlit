<?php

namespace App\Services;

use League\CommonMark\CommonMarkConverter;
use League\CommonMark\Environment\Environment;
use League\CommonMark\Extension\Footnote\FootnoteExtension;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\DB;
use League\CommonMark\Extension\CommonMark\CommonMarkCoreExtension;
use League\HTMLToMarkdown\HtmlConverter;
use App\Http\Controllers\MarkConverter;
use App\Http\Controllers\AnchorConverter;
use DOMDocument;

class CustomMarkdownConverter
{
    protected $converter;

    public function __construct()
    {
        // Create an environment with footnote support
        $environment = new Environment([
            'backref_class' => 'footnote-backref',  // Class for the backref link
            'container_add_hr' => true,  // Add <hr> before footnotes
        ]);
        $environment->addExtension(new CommonMarkCoreExtension());
        $environment->addExtension(new FootnoteExtension()); // Add footnote extension

        // Initialize the converter using the environment
        $this->converter = new CommonMarkConverter([], $environment);
    }

    public function convert($markdown)
    {
        // Convert the markdown to HTML using the initialized converter
        return $this->converter->convertToHtml($markdown);
    }
}
