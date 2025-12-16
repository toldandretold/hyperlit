<?php

namespace App\Services\DocumentImport;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class SanitizationService
{
    /**
     * Sanitize HTML file by removing dangerous tags and attributes
     */
    public function sanitizeHtmlFile(string $filePath): void
    {
        $originalContent = File::get($filePath);

        // Save content before sanitization for comparison
        $beforeLength = strlen($originalContent);

        // Remove potentially dangerous HTML tags and attributes
        $content = strip_tags($originalContent, '<html><head><body><div><span><p><h1><h2><h3><h4><h5><h6><br><strong><b><em><i><ul><ol><li><a><img><blockquote><code><pre><table><tr><td><th><thead><tbody><hr><sup><sub>');

        // Remove javascript: and data: URLs (quoted and unquoted)
        $content = preg_replace('/(?:javascript|data|vbscript):[^"\'\s>]*/i', '', $content);

        // Remove all event handlers (onclick, onload, onerror, etc.)
        // Handles quoted: onclick="..." and onclick='...'
        $content = preg_replace('/\son\w+\s*=\s*["\'][^"\']*["\']/i', '', $content);
        // Handles unquoted: onclick=alert(1) or onclick=func()
        $content = preg_replace('/\son\w+\s*=\s*[^\s>"\']+/i', '', $content);

        // Remove style attributes that might contain expressions or javascript
        $content = preg_replace('/\sstyle\s*=\s*["\'][^"\']*(?:expression|javascript|url\s*\()[^"\']*["\']/i', '', $content);

        // Log what sanitization removed
        $afterLength = strlen($content);

        Log::info('HTML sanitization results', [
            'file_path' => basename($filePath),
            'before_length' => $beforeLength,
            'after_length' => $afterLength,
            'removed_chars' => $beforeLength - $afterLength,
            'content_changed' => $originalContent !== $content
        ]);

        if ($originalContent !== $content) {
            // Save sanitized version for comparison
            $debugSanitizedPath = dirname($filePath) . '/debug_sanitized.html';
            File::put($debugSanitizedPath, $content);
            Log::warning('HTML sanitization changed content, saved debug copy to: ' . $debugSanitizedPath);
        }

        File::put($filePath, $content);
    }

    /**
     * Sanitize markdown file by removing dangerous content
     */
    public function sanitizeMarkdownFile(string $filePath): void
    {
        $originalContent = File::get($filePath);

        // Save content before sanitization for comparison
        $beforeLength = strlen($originalContent);
        $beforeFootnotes = preg_match_all('/^10[2-5]\s/', $originalContent, $matches);

        // Remove potentially dangerous HTML tags and attributes
        $content = strip_tags($originalContent, '<h1><h2><h3><h4><h5><h6><p><br><strong><em><ul><ol><li><a><img><blockquote><code><pre>');

        // Remove javascript: and data: URLs (quoted and unquoted)
        $content = preg_replace('/(?:javascript|data|vbscript):[^"\'\s>]*/i', '', $content);

        // Remove all event handlers (onclick, onload, onerror, etc.)
        $content = preg_replace('/\son\w+\s*=\s*["\'][^"\']*["\']/i', '', $content);
        $content = preg_replace('/\son\w+\s*=\s*[^\s>"\']+/i', '', $content);

        // Log what sanitization removed
        $afterLength = strlen($content);
        $afterFootnotes = preg_match_all('/^10[2-5]\s/', $content, $matches);

        Log::warning('Markdown sanitization results', [
            'file_path' => basename($filePath),
            'before_length' => $beforeLength,
            'after_length' => $afterLength,
            'removed_chars' => $beforeLength - $afterLength,
            'footnotes_before' => $beforeFootnotes,
            'footnotes_after' => $afterFootnotes,
            'content_changed' => $originalContent !== $content
        ]);

        if ($originalContent !== $content) {
            // Save sanitized version for comparison
            $debugSanitizedPath = dirname($filePath) . '/debug_sanitized.md';
            File::put($debugSanitizedPath, $content);
            Log::warning('Sanitization changed content, saved debug copy to: ' . $debugSanitizedPath);
        }

        File::put($filePath, $content);
    }
}
