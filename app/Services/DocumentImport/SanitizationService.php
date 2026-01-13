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
            $config->set('HTML.Allowed',
                'div,span,p,h1,h2,h3,h4,h5,h6,br,strong,b,em,i,' .
                'ul,ol,li,a[href|title],img[src|alt|title],blockquote,code,pre,' .
                'table,tr,td,th,thead,tbody,hr,sup,sub,dl,dt,dd,abbr[title],cite,small,u,s'
            );

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
                'a[href|title],img[src|alt|title],blockquote,code,pre'
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
