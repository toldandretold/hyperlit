<?php

namespace App\Services\DocumentImport;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use HTMLPurifier;
use HTMLPurifier_Config;

class SanitizationService
{
    private ?HTMLPurifier $htmlPurifier = null;
    private ?HTMLPurifier $markdownPurifier = null;

    /**
     * Get configured HTMLPurifier instance for HTML files
     * 🔒 SECURITY: Whitelist-based sanitization - only explicitly allowed elements pass
     * Note: HTMLPurifier works on fragments, not full documents - we extract body content first
     */
    private function getHtmlPurifier(): HTMLPurifier
    {
        if ($this->htmlPurifier === null) {
            $config = HTMLPurifier_Config::createDefault();

            // Allow safe structural and formatting tags (fragment-level only, no html/head/body)
            // Note: HTMLPurifier only supports HTML4 elements - HTML5 semantic elements get stripped
            // but their content is preserved
            //
            // `a[class|id]` is allowed so internal citation/bibliography anchors emitted by
            // upstream Python preprocessors (e.g. ar5iv_preprocessor.py: in-text-citation,
            // bib-entry) survive sanitization. The classes themselves are constrained below.
            $config->set('HTML.Allowed',
                'div,span,p,h1,h2,h3,h4,h5,h6,br,strong,b,em,i,' .
                'ul,ol,li,a[href|title|class|id],img[src|alt|title|width|height],blockquote,code,pre,' .
                'table,tr,td,th,thead,tbody,hr,sup[class|id|fn-count-id],sub,dl,dt,dd,abbr[title],cite,small,u,s,' .
                'latex[data-math],latex-block[data-math]'
            );

            // Only allow the small set of functional classes Hyperlit's pipeline uses.
            // Arbitrary classes from source HTML still get stripped — these are an allowlist,
            // not a passthrough.
            $config->set('Attr.AllowedClasses', [
                'in-text-citation',
                'bib-entry',
                'footnote-ref',
                'citation-ref',
                'pageNumber',
            ]);

            // ar5iv anchors carry id="bib.bibN" which the citation-popup hrefs target.
            // HTMLPurifier strips id="..." by default; enable it so internal anchors survive.
            $config->set('Attr.EnableID', true);

            // Block dangerous URI schemes
            $config->set('URI.AllowedSchemes', ['http' => true, 'https' => true, 'mailto' => true]);

            // Disable external resources for security
            $config->set('URI.DisableExternalResources', false);

            // Remove empty tags
            $config->set('AutoFormat.RemoveEmpty', true);

            // Set cache directory
            $cacheDir = storage_path('app/htmlpurifier');
            if (!is_dir($cacheDir)) {
                mkdir($cacheDir, 0755, true);
            }
            $config->set('Cache.SerializerPath', $cacheDir);

            // Custom-element + attribute registration must come LAST:
            // maybeGetRawHTMLDefinition() finalises the config, and any
            // config->set() call after this point throws "Cannot set directive
            // after finalization".
            //
            // Bump DefinitionRev whenever the addElement / addAttribute calls
            // below change so HTMLPurifier rebuilds its cached definition.
            $config->set('HTML.DefinitionID', 'hyperlit-html-purifier');
            $config->set('HTML.DefinitionRev', 4);
            if ($def = $config->maybeGetRawHTMLDefinition()) {
                $def->addAttribute('sup', 'fn-count-id', 'Text');

                // <latex data-math="..."> and <latex-block data-math="...">
                // are Hyperlit-internal math markers consumed by
                // renderMathElements() in lazyLoaderFactory.js. base64-encoded
                // LaTeX source lives in data-math; KaTeX renders client-side.
                //
                // Contents = 'Inline' (not 'Empty') so the ar5iv preprocessor
                // can put the raw LaTeX as text content. That serves two
                // purposes: (1) AutoFormat.RemoveEmpty doesn't prune the element
                // (which would also prune its containing <p>), (2) the LaTeX
                // source is a useful fallback if KaTeX rendering fails.
                $def->addElement('latex',       'Inline', 'Inline', 'Common', ['data-math' => 'Text']);
                $def->addElement('latex-block', 'Block',  'Inline', 'Common', ['data-math' => 'Text']);
            }

            $this->htmlPurifier = new HTMLPurifier($config);
        }

        return $this->htmlPurifier;
    }

    /**
     * Get configured HTMLPurifier instance for Markdown files (more restrictive)
     */
    private function getMarkdownPurifier(): HTMLPurifier
    {
        if ($this->markdownPurifier === null) {
            $config = HTMLPurifier_Config::createDefault();

            // Markdown needs fewer HTML elements
            $config->set('HTML.Allowed',
                'h1,h2,h3,h4,h5,h6,p,br,strong,b,em,i,ul,ol,li,' .
                'a[href|title],img[src|alt|title|width|height],blockquote,code,pre'
            );

            // Block dangerous URI schemes
            $config->set('URI.AllowedSchemes', ['http' => true, 'https' => true, 'mailto' => true]);

            // Remove empty tags
            $config->set('AutoFormat.RemoveEmpty', true);

            // Set cache directory
            $cacheDir = storage_path('app/htmlpurifier');
            if (!is_dir($cacheDir)) {
                mkdir($cacheDir, 0755, true);
            }
            $config->set('Cache.SerializerPath', $cacheDir);

            $this->markdownPurifier = new HTMLPurifier($config);
        }

        return $this->markdownPurifier;
    }

    /**
     * Sanitize HTML file using HTMLPurifier
     * 🔒 SECURITY: Replaces vulnerable strip_tags() with proper whitelist-based sanitization
     * Handles full HTML documents by extracting body content first
     */
    public function sanitizeHtmlFile(string $filePath): void
    {
        $originalContent = File::get($filePath);
        $beforeLength = strlen($originalContent);

        // Extract body content if this is a full HTML document
        // HTMLPurifier works on fragments, not full documents
        $bodyContent = $this->extractBodyContent($originalContent);

        // Use HTMLPurifier for proper sanitization
        $sanitizedBody = $this->getHtmlPurifier()->purify($bodyContent);

        // Reconstruct as a valid HTML document
        $content = $this->wrapInHtmlDocument($sanitizedBody);

        $afterLength = strlen($content);

        Log::info('HTML sanitization results (HTMLPurifier)', [
            'file_path' => basename($filePath),
            'before_length' => $beforeLength,
            'after_length' => $afterLength,
            'removed_chars' => $beforeLength - $afterLength,
            'content_changed' => $originalContent !== $content
        ]);

        if ($originalContent !== $content) {
            Log::warning('HTML sanitization changed content', [
                'file' => basename($filePath),
                'chars_removed' => $beforeLength - $afterLength
            ]);
        }

        File::put($filePath, $content);
    }

    /**
     * Extract body content from a full HTML document
     */
    private function extractBodyContent(string $html): string
    {
        // Try to extract content between <body> tags
        if (preg_match('/<body[^>]*>(.*?)<\/body>/is', $html, $matches)) {
            return $matches[1];
        }

        // If no body tags, check if it has html/head structure and strip those
        $content = $html;
        $content = preg_replace('/<html[^>]*>/i', '', $content);
        $content = preg_replace('/<\/html>/i', '', $content);
        $content = preg_replace('/<head[^>]*>.*?<\/head>/is', '', $content);

        return trim($content);
    }

    /**
     * Wrap sanitized content in a basic HTML document structure
     */
    private function wrapInHtmlDocument(string $content): string
    {
        return "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"UTF-8\">\n</head>\n<body>\n{$content}\n</body>\n</html>";
    }

    /**
     * Sanitize markdown file
     * Note: HTMLPurifier is NOT used here because it corrupts markdown syntax
     * (e.g., > becomes &gt;, breaking blockquotes)
     * HTML sanitization happens in process_document.py via bleach.clean()
     */
    public function sanitizeMarkdownFile(string $filePath): void
    {
        // Don't run HTMLPurifier on markdown - it corrupts markdown syntax
        // HTML sanitization happens in process_document.py via bleach.clean()
        Log::info('Markdown sanitization skipped (handled by bleach in Python)', [
            'file_path' => basename($filePath)
        ]);
    }
}
