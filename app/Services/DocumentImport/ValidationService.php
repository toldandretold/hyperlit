<?php

namespace App\Services\DocumentImport;

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Log;

class ValidationService
{
    /**
     * Validate an uploaded file based on extension and content
     */
    public function validateUploadedFile(UploadedFile $file): bool
    {
        // Check file size (50MB max)
        if ($file->getSize() > 50 * 1024 * 1024) {
            Log::debug('File validation failed: size too large', [
                'size' => $file->getSize(),
                'max_size' => 50 * 1024 * 1024
            ]);
            return false;
        }

        // Validate MIME type
        $allowedMimes = [
            'text/markdown',
            'text/plain',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/epub+zip',
            'text/html',
            'application/zip',
            'application/x-zip-compressed'
        ];

        if (!in_array($file->getMimeType(), $allowedMimes)) {
            Log::debug('File validation failed: invalid MIME type', [
                'mime_type' => $file->getMimeType(),
                'allowed_mimes' => $allowedMimes
            ]);
            return false;
        }

        // Additional content validation for specific file types
        $extension = strtolower($file->getClientOriginalExtension());

        switch ($extension) {
            case 'epub':
                return $this->validateEpubFile($file);
            case 'docx':
            case 'doc':
                return $this->validateDocFile($file);
            case 'md':
                return $this->validateMarkdownFile($file);
            case 'html':
                return $this->validateHtmlFile($file);
            case 'zip':
                return $this->validateZipFile($file);
        }

        return true;
    }

    /**
     * Validate EPUB file structure
     */
    public function validateEpubFile(UploadedFile $file): bool
    {
        $zip = new \ZipArchive();
        $result = $zip->open($file->getPathname());

        if ($result !== TRUE) {
            Log::debug('EPUB validation failed: cannot open as ZIP', [
                'zip_error_code' => $result
            ]);
            return false;
        }

        $hasContainer = $zip->locateName('META-INF/container.xml') !== false;
        $hasMimetype = $zip->locateName('mimetype') !== false;

        $zip->close();

        if (!$hasContainer || !$hasMimetype) {
            Log::debug('EPUB validation failed: missing required files', [
                'has_container' => $hasContainer,
                'has_mimetype' => $hasMimetype
            ]);
        }

        return $hasContainer && $hasMimetype;
    }

    /**
     * Validate DOC/DOCX file structure
     */
    public function validateDocFile(UploadedFile $file): bool
    {
        if (strtolower($file->getClientOriginalExtension()) === 'docx') {
            $zip = new \ZipArchive();
            $result = $zip->open($file->getPathname());

            if ($result !== TRUE) {
                Log::debug('DOCX validation failed: cannot open as ZIP');
                return false;
            }

            $hasWordDoc = $zip->locateName('word/document.xml') !== false;
            $zip->close();

            if (!$hasWordDoc) {
                Log::debug('DOCX validation failed: missing word/document.xml');
            }

            return $hasWordDoc;
        }

        return true; // For .doc files, basic MIME check is sufficient
    }

    /**
     * Validate markdown file for suspicious content
     */
    public function validateMarkdownFile(UploadedFile $file): bool
    {
        $handle = fopen($file->getPathname(), 'r');
        $content = fread($handle, 1024);
        fclose($handle);

        $suspiciousPatterns = [
            '/<script/i',
            '/javascript:/i',
            '/vbscript:/i',
            '/onload=/i',
            '/onerror=/i'
        ];

        foreach ($suspiciousPatterns as $pattern) {
            if (preg_match($pattern, $content)) {
                Log::warning('Markdown validation failed: suspicious content detected', [
                    'pattern_matched' => $pattern
                ]);
                return false;
            }
        }

        return true;
    }

    /**
     * Validate HTML file for suspicious content
     */
    public function validateHtmlFile(UploadedFile $file): bool
    {
        $handle = fopen($file->getPathname(), 'r');
        $content = fread($handle, 4096); // Read more for HTML files
        fclose($handle);

        // More comprehensive security patterns for HTML
        $suspiciousPatterns = [
            '/<script[^>]*>/i',
            '/javascript:/i',
            '/vbscript:/i',
            '/data:/i',
            '/on\w+\s*=/i', // Any on* event handlers (onclick, onload, etc.)
            '/<iframe/i',
            '/<object/i',
            '/<embed/i',
            '/<form/i',
            '/<input/i',
            '/<meta[^>]*http-equiv[^>]*refresh/i',
            '/expression\s*\(/i', // CSS expressions
            '/url\s*\(\s*["\']?javascript:/i',
            '/<link[^>]*href[^>]*javascript:/i',
            '/<style[^>]*>[^<]*javascript:/i'
        ];

        foreach ($suspiciousPatterns as $pattern) {
            if (preg_match($pattern, $content)) {
                Log::warning('HTML validation failed: suspicious content detected', [
                    'pattern_matched' => $pattern,
                    'file_name' => $file->getClientOriginalName()
                ]);
                return false;
            }
        }

        // Validate basic HTML structure
        if (!preg_match('/<html/i', $content) && !preg_match('/<body/i', $content) && !preg_match('/<div/i', $content)) {
            Log::debug('HTML validation: No recognizable HTML structure found');
            // Don't fail for this - could be HTML fragments
        }

        return true;
    }

    /**
     * Validate ZIP file structure and contents
     */
    public function validateZipFile(UploadedFile $file): bool
    {
        $zip = new \ZipArchive();
        $result = $zip->open($file->getPathname());

        if ($result !== TRUE) {
            Log::debug('ZIP validation failed: cannot open as ZIP', [
                'zip_error_code' => $result
            ]);
            return false;
        }

        $numFiles = $zip->numFiles;
        $hasMarkdown = false;
        $suspiciousFiles = 0;
        $totalSize = 0;

        // Scan all files in ZIP
        for ($i = 0; $i < $numFiles; $i++) {
            $stat = $zip->statIndex($i);
            if (!$stat) continue;

            $filename = $stat['name'];
            $filesize = $stat['size'];
            $totalSize += $filesize;

            // Check for path traversal
            if (strpos($filename, '..') !== false || strpos($filename, '/') === 0) {
                Log::warning('ZIP validation failed: suspicious path', ['filename' => $filename]);
                $suspiciousFiles++;
                continue;
            }

            // Check file extension
            $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

            if ($extension === 'md') {
                $hasMarkdown = true;
            } elseif (in_array($extension, ['exe', 'bat', 'sh', 'php', 'js', 'vbs', 'scr'])) {
                Log::warning('ZIP validation failed: executable file detected', ['filename' => $filename]);
                $suspiciousFiles++;
            }

            // Check individual file size (50MB max)
            if ($filesize > 50 * 1024 * 1024) {
                Log::warning('ZIP validation failed: file too large', ['filename' => $filename, 'size' => $filesize]);
                $suspiciousFiles++;
            }
        }

        $zip->close();

        // Validation rules
        if (!$hasMarkdown) {
            Log::debug('ZIP validation failed: no markdown file found');
            return false;
        }

        if ($suspiciousFiles > 0) {
            Log::warning('ZIP validation failed: suspicious files detected', ['count' => $suspiciousFiles]);
            return false;
        }

        // Check total uncompressed size (200MB max)
        if ($totalSize > 200 * 1024 * 1024) {
            Log::warning('ZIP validation failed: total size too large', ['total_size' => $totalSize]);
            return false;
        }

        return true;
    }

    /**
     * Validate image file from path
     */
    public function validateImageFile(string $filePath): bool
    {
        // Check file exists and is readable
        if (!file_exists($filePath) || !is_readable($filePath)) {
            Log::warning('Image file not readable', ['path' => basename($filePath)]);
            return false;
        }

        // Check file size (10MB max for images)
        $fileSize = filesize($filePath);
        if ($fileSize > 10 * 1024 * 1024) {
            Log::warning('Image file too large', ['path' => basename($filePath), 'size' => $fileSize]);
            return false;
        }

        // Validate MIME type
        $mimeType = mime_content_type($filePath);
        $allowedMimes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/svg+xml'
        ];

        if (!in_array($mimeType, $allowedMimes)) {
            Log::warning('Invalid image MIME type', ['path' => basename($filePath), 'mime' => $mimeType]);
            return false;
        }

        // For SVG, do additional content validation
        if ($mimeType === 'image/svg+xml') {
            return $this->validateSvgFile($filePath);
        }

        // Try to verify it's actually an image by reading image info
        try {
            $imageInfo = getimagesize($filePath);
            if ($imageInfo === false) {
                Log::warning('Invalid image file', ['path' => basename($filePath)]);
                return false;
            }
        } catch (\Exception $e) {
            Log::warning('Image validation exception', ['path' => basename($filePath), 'error' => $e->getMessage()]);
            return false;
        }

        return true;
    }

    /**
     * Validate image file from upload
     */
    public function validateImageFileFromUpload(UploadedFile $uploadedFile): bool
    {
        // Check file size (10MB max for images)
        $fileSize = $uploadedFile->getSize();
        if ($fileSize > 10 * 1024 * 1024) {
            Log::warning('Uploaded image file too large', [
                'name' => $uploadedFile->getClientOriginalName(),
                'size' => $fileSize
            ]);
            return false;
        }

        // Validate MIME type
        $mimeType = $uploadedFile->getMimeType();
        $allowedMimes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/svg+xml'
        ];

        if (!in_array($mimeType, $allowedMimes)) {
            Log::warning('Invalid uploaded image MIME type', [
                'name' => $uploadedFile->getClientOriginalName(),
                'mime' => $mimeType
            ]);
            return false;
        }

        // For SVG, do additional content validation
        if ($mimeType === 'image/svg+xml') {
            return $this->validateSvgFileFromUpload($uploadedFile);
        }

        return true;
    }

    /**
     * Validate SVG file from path for malicious content
     */
    public function validateSvgFile(string $filePath): bool
    {
        $content = file_get_contents($filePath);
        if ($content === false) {
            return false;
        }

        return $this->checkSvgContent($content, basename($filePath));
    }

    /**
     * Validate SVG file from upload for malicious content
     */
    public function validateSvgFileFromUpload(UploadedFile $uploadedFile): bool
    {
        $content = $uploadedFile->getContent();
        if ($content === false) {
            return false;
        }

        return $this->checkSvgContent($content, $uploadedFile->getClientOriginalName());
    }

    /**
     * Check SVG content for suspicious patterns
     */
    private function checkSvgContent(string $content, string $filename): bool
    {
        $suspiciousPatterns = [
            '/<script/i',
            '/javascript:/i',
            '/vbscript:/i',
            '/on\w+\s*=/i', // Event handlers
            '/<iframe/i',
            '/<object/i',
            '/<embed/i',
            '/<form/i',
            '/expression\s*\(/i'
        ];

        foreach ($suspiciousPatterns as $pattern) {
            if (preg_match($pattern, $content)) {
                Log::warning('Suspicious SVG content detected', [
                    'name' => $filename,
                    'pattern' => $pattern
                ]);
                return false;
            }
        }

        return true;
    }
}
