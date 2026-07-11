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
        // Check file size (250MB max — PDFs above Mistral's 50MB API limit are chunked in mistral_ocr.py)
        if ($file->getSize() > 250 * 1024 * 1024) {
            Log::debug('File validation failed: size too large', [
                'size' => $file->getSize(),
                'max_size' => 250 * 1024 * 1024
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
            'application/x-zip-compressed',
            'application/pdf'
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
            case 'pdf':
                return $this->validatePdfUpload($file);
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
     * SECURITY: Reads entire file to prevent bypass via content after first chunk
     */
    public function validateMarkdownFile(UploadedFile $file): bool
    {
        // Check file size first - reject if too large (10MB limit)
        $maxSize = 10 * 1024 * 1024;
        if ($file->getSize() > $maxSize) {
            Log::warning('Markdown validation failed: file too large', [
                'size' => $file->getSize(),
                'max_size' => $maxSize
            ]);
            return false;
        }

        // SECURITY FIX: Read entire file, not just first 1KB
        $content = file_get_contents($file->getPathname());

        // Markdown is TEXT. Reject binary / non-UTF-8 payloads (a binary blob renamed `.md`):
        // they pass the suspicious-pattern scan (random bytes match nothing) but crash the
        // downstream converter with a 500. Reject cleanly here instead.
        if ($content === false || !mb_check_encoding($content, 'UTF-8')) {
            Log::warning('Markdown validation failed: content is not valid UTF-8 text');
            return false;
        }

        $suspiciousPatterns = [
            '/<script/i',
            '/javascript:/i',
            '/vbscript:/i',
            '/onload=/i',
            '/onerror=/i',
            '/onclick=/i',
            '/onmouseover=/i',
            '/onfocus=/i',
            '/<iframe/i',
            '/<object/i',
            '/<embed/i',
            // data: URIs in dangerous contexts only (not plain text like "https://data.europa.eu/")
            '/(src|href)\s*=\s*["\']?\s*data:/i',  // HTML attributes
            '/url\s*\(\s*["\']?\s*data:/i',        // CSS url()
            '/\]\s*\(\s*data:/i',                  // Markdown links [text](data:...)
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
     * SECURITY: Reads entire file to prevent bypass via content after first chunk
     */
    public function validateHtmlFile(UploadedFile $file): bool
    {
        // Check file size first - reject if too large (10MB limit)
        $maxSize = 10 * 1024 * 1024;
        if ($file->getSize() > $maxSize) {
            Log::warning('HTML validation failed: file too large', [
                'size' => $file->getSize(),
                'max_size' => $maxSize
            ]);
            return false;
        }

        // SECURITY FIX: Read entire file, not just first 4KB
        $content = file_get_contents($file->getPathname());

        // More comprehensive security patterns for HTML
        $suspiciousPatterns = [
            '/<script[^>]*>/i',
            '/javascript:/i',
            '/vbscript:/i',
            // data: URIs in dangerous contexts only (not plain text like "https://data.europa.eu/")
            '/(src|href)\s*=\s*["\']?\s*data:/i',  // HTML attributes with data: URIs
            '/url\s*\(\s*["\']?\s*data:/i',        // CSS url() with data: URIs
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
     * Validate a PDF file from a file path (used by PdfProcessor before OCR)
     */
    public function validatePdfFile(string $filePath): bool
    {
        if (!file_exists($filePath) || !is_readable($filePath)) {
            Log::warning('PDF file not readable', ['path' => basename($filePath)]);
            return false;
        }

        // 250MB max — chunked OCR handles PDFs above the 50MB Mistral API limit by splitting in mistral_ocr.py
        $fileSize = filesize($filePath);
        if ($fileSize > 250 * 1024 * 1024) {
            Log::warning('PDF file too large', ['path' => basename($filePath), 'size' => $fileSize]);
            return false;
        }

        // Check magic bytes: PDF spec requires first 5 bytes to be %PDF-
        $handle = fopen($filePath, 'rb');
        $header = fread($handle, 5);
        fclose($handle);

        if ($header !== '%PDF-') {
            Log::warning('PDF magic bytes check failed', ['path' => basename($filePath)]);
            return false;
        }

        // MIME type check
        $mimeType = mime_content_type($filePath);
        if ($mimeType !== 'application/pdf') {
            Log::warning('PDF MIME type check failed', ['path' => basename($filePath), 'mime' => $mimeType]);
            return false;
        }

        return true;
    }

    /**
     * Validate a PDF file from an upload (used by web upload path)
     */
    public function validatePdfUpload(UploadedFile $file): bool
    {
        return $this->validatePdfFile($file->getPathname());
    }

    /**
     * Parse + validate a client-supplied OCR response (the macOS app's on-device
     * PDF OCR, shaped like Mistral's ocr_response.json). Returns the decoded array
     * on success, null on any failure — decode once, so the controller doesn't
     * re-parse a potentially very large JSON just to stamp the model field.
     *
     * SECURITY: images[].id becomes a literal filename under the book's media/
     * dir (save_images() in app/Python/ingestion/pdf/assembly.py joins it with no
     * traversal guard), so the id regex here is the gate against path traversal.
     * Image *content* is re-validated per file by PdfProcessor stage 2
     * (validateImageFile, which deletes failures), and the markdown itself is no
     * new trust surface — users can already upload arbitrary .md to this endpoint.
     */
    public function parseOcrResponseFile(string $filePath): ?array
    {
        $fail = function (string $reason, array $ctx = []) {
            Log::warning("OCR response validation failed: {$reason}", $ctx);
            return null;
        };

        if (!file_exists($filePath) || !is_readable($filePath)) {
            return $fail('file not readable');
        }
        if (filesize($filePath) > 100 * 1024 * 1024) {
            return $fail('file too large', ['size' => filesize($filePath)]);
        }

        $data = json_decode(file_get_contents($filePath), true, 32);
        if (!is_array($data)) {
            return $fail('not valid JSON', ['json_error' => json_last_error_msg()]);
        }

        if (isset($data['model']) && !is_string($data['model'])) {
            return $fail('model is not a string');
        }

        $pages = $data['pages'] ?? null;
        if (!is_array($pages) || count($pages) < 1 || count($pages) > 2000) {
            return $fail('pages must be an array of 1-2000 entries', ['count' => is_array($pages) ? count($pages) : null]);
        }

        foreach ($pages as $i => $page) {
            if (!is_array($page)) {
                return $fail('page is not an object', ['page' => $i]);
            }
            if (!is_int($page['index'] ?? null)) {
                return $fail('page index missing or not an integer', ['page' => $i]);
            }
            if (!is_string($page['markdown'] ?? null) || strlen($page['markdown']) > 2 * 1024 * 1024) {
                return $fail('page markdown missing, not a string, or over 2MB', ['page' => $i]);
            }
            foreach (['header', 'footer'] as $band) {
                if (isset($page[$band]) && (!is_string($page[$band]) || strlen($page[$band]) > 4096)) {
                    return $fail("page {$band} not a string or over 4KB", ['page' => $i]);
                }
            }

            $images = $page['images'] ?? [];
            if (!is_array($images) || count($images) > 50) {
                return $fail('page images not an array or over 50 entries', ['page' => $i]);
            }
            foreach ($images as $j => $img) {
                if (!is_array($img)) {
                    return $fail('image entry is not an object', ['page' => $i, 'image' => $j]);
                }
                $id = $img['id'] ?? null;
                if (!is_string($id) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}\.(jpe?g|png)$/', $id) || str_contains($id, '..')) {
                    return $fail('image id invalid (must be a safe filename ending .jpg/.jpeg/.png)', ['page' => $i, 'image' => $j]);
                }
                $b64 = $img['image_base64'] ?? null;
                if (!is_string($b64)) {
                    return $fail('image_base64 missing or not a string', ['page' => $i, 'image' => $j]);
                }
                // Strip a data-URI prefix the same way save_images() does before decoding.
                if (str_starts_with($b64, 'data:')) {
                    $comma = strpos($b64, ',');
                    $b64 = $comma === false ? '' : substr($b64, $comma + 1);
                }
                // ~10MB decoded cap (matches validateImageFile) without decoding: base64 inflates 4/3.
                if (strlen($b64) > 14 * 1024 * 1024) {
                    return $fail('image over 10MB decoded', ['page' => $i, 'image' => $j]);
                }
                if (base64_decode($b64, true) === false) {
                    return $fail('image_base64 is not valid base64', ['page' => $i, 'image' => $j]);
                }
            }
        }

        return $data;
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
            // Script-related
            '/<script/i',
            '/javascript:/i',
            '/vbscript:/i',

            // Event handlers
            '/on\w+\s*=/i',

            // Dangerous elements that can embed external content
            '/<iframe/i',
            '/<object/i',
            '/<embed/i',
            '/<form/i',
            '/<foreignObject/i',               // Can embed arbitrary HTML including scripts
            '/<animate/i',                     // SMIL animation can trigger events
            '/<set/i',                         // SMIL set can modify attributes
            '/<animateTransform/i',            // Animation element

            // External references that could load malicious content
            '/<use[^>]+href\s*=\s*["\'][^"\']*:\/\//i',  // <use> with external URL
            '/xlink:href\s*=\s*["\'](?:javascript|data|vbscript):/i',  // xlink with dangerous protocols

            // CSS expressions
            '/expression\s*\(/i',
            '/url\s*\(\s*["\']?\s*(?:javascript|data|vbscript):/i',  // CSS url() with dangerous protocols

            // data: URIs in dangerous contexts only (not plain text)
            '/(src|href)\s*=\s*["\']?\s*data:/i',  // SVG attributes with data: URIs
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
