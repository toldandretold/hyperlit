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

    /**
     * Simple markdown to HTML conversion that preserves multiple footnote sections
     * Does not process footnotes - just converts basic structure
     */
    public function convertSimple($markdown)
    {
        $lines = explode("\n", $markdown);
        $htmlLines = [];
        $inCodeBlock = false;
        
        foreach ($lines as $line) {
            // Handle code blocks
            if (strpos(trim($line), '```') === 0) {
                if ($inCodeBlock) {
                    $htmlLines[] = '</pre></code>';
                    $inCodeBlock = false;
                } else {
                    $htmlLines[] = '<code><pre>';
                    $inCodeBlock = true;
                }
                continue;
            }
            
            if ($inCodeBlock) {
                $htmlLines[] = htmlspecialchars($line);
                continue;
            }
            
            $trimmed = trim($line);
            
            // Handle headers
            if (preg_match('/^(#{1,6})\s+(.+)$/', $trimmed, $matches)) {
                $level = strlen($matches[1]);
                $headerText = $matches[2];
                $headerId = strtolower(preg_replace('/[^a-zA-Z0-9\s-]/', '', $headerText));
                $headerId = str_replace(' ', '-', $headerId);
                $htmlLines[] = "<h{$level} id=\"{$headerId}\">" . htmlspecialchars($headerText) . "</h{$level}>";
                continue;
            }
            
            // Handle horizontal rules
            if ($trimmed === '---') {
                $htmlLines[] = '<hr />';
                continue;
            }
            
            // Handle empty lines
            if ($trimmed === '') {
                $htmlLines[] = '';
                continue;
            }
            
            // Everything else as paragraph - preserve footnote patterns as-is
            $htmlLines[] = '<p>' . htmlspecialchars($line) . '</p>';
        }
        
        $bodyContent = implode("\n", $htmlLines);
        
        return "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>Converted Document</title>\n</head>\n<body>\n{$bodyContent}\n</body>\n</html>";
    }
}
