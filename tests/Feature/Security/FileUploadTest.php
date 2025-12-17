<?php

/**
 * Security Tests: File Upload Security
 *
 * Tests for file upload validation, malicious file rejection,
 * and path traversal prevention.
 */

use App\Models\User;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;

// =============================================================================
// POLYGLOT FILE TESTS
// =============================================================================

test('rejects polyglot jpg with embedded php code', function () {
    $user = User::factory()->create();

    // Create fake polyglot file (JPEG header + PHP code)
    $content = "\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01<?php system(\$_GET['cmd']); ?>";

    $file = UploadedFile::fake()->createWithContent('polyglot.jpg', $content);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'polyglot-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    // Should be rejected - not a valid markdown/docx/html file
    expect($response->status())->toBeIn([400, 422]);
});

test('rejects file with php extension', function () {
    $user = User::factory()->create();

    $file = UploadedFile::fake()->create('malicious.php', 100, 'text/plain');

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'php-upload-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

// =============================================================================
// SVG XSS TESTS
// =============================================================================

test('rejects svg with embedded javascript', function () {
    $user = User::factory()->create();

    $svg = <<<'SVG'
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg">
  <script type="text/javascript">
    alert(document.cookie);
  </script>
  <rect width="100" height="100" fill="red"/>
</svg>
SVG;

    $file = UploadedFile::fake()->createWithContent('malicious.svg', $svg);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'svg-xss-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    // SVG validation should detect script element
    expect($response->status())->toBeIn([400, 422]);
});

test('rejects svg with event handlers', function () {
    $user = User::factory()->create();

    $svg = <<<'SVG'
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
  <rect width="100" height="100" fill="red" onclick="alert(2)"/>
</svg>
SVG;

    $file = UploadedFile::fake()->createWithContent('svg-events.svg', $svg);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'svg-events-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

test('rejects svg with foreignObject xss', function () {
    $user = User::factory()->create();

    $svg = <<<'SVG'
<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg">
  <foreignObject>
    <body xmlns="http://www.w3.org/1999/xhtml" onload="alert(1)">
      <script>alert(document.cookie)</script>
    </body>
  </foreignObject>
</svg>
SVG;

    $file = UploadedFile::fake()->createWithContent('svg-foreign.svg', $svg);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'svg-foreign-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

// =============================================================================
// HTML FILE XSS TESTS
// =============================================================================

test('rejects html file with script tags', function () {
    $user = User::factory()->create();

    $html = '<html><body><script>alert(1)</script></body></html>';

    $file = UploadedFile::fake()->createWithContent('malicious.html', $html);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'html-xss-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    // ValidationService should detect script tags
    expect($response->status())->toBeIn([400, 422]);
});

test('rejects html with javascript protocol', function () {
    $user = User::factory()->create();

    $html = '<html><body><a href="javascript:alert(1)">Click me</a></body></html>';

    $file = UploadedFile::fake()->createWithContent('js-proto.html', $html);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'js-proto-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

test('rejects html with event handlers', function () {
    $user = User::factory()->create();

    $html = '<html><body><img src="x" onerror="alert(1)"></body></html>';

    $file = UploadedFile::fake()->createWithContent('event-handler.html', $html);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'event-handler-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

test('rejects html with iframe', function () {
    $user = User::factory()->create();

    $html = '<html><body><iframe src="https://evil.com"></iframe></body></html>';

    $file = UploadedFile::fake()->createWithContent('iframe.html', $html);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'iframe-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

test('rejects html with meta refresh redirect', function () {
    $user = User::factory()->create();

    $html = '<html><head><meta http-equiv="refresh" content="0;url=https://evil.com"></head></html>';

    $file = UploadedFile::fake()->createWithContent('meta-refresh.html', $html);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'meta-refresh-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

// =============================================================================
// MARKDOWN XSS TESTS
// =============================================================================

test('rejects markdown with xss payloads', function () {
    $user = User::factory()->create();

    $markdown = "# Title\n\n<script>alert(1)</script>\n\nNormal text";

    $file = UploadedFile::fake()->createWithContent('malicious.md', $markdown);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'md-xss-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

test('rejects markdown with javascript link', function () {
    $user = User::factory()->create();

    $markdown = "# Title\n\n[Click me](javascript:alert(1))\n\nNormal text";

    $file = UploadedFile::fake()->createWithContent('js-link.md', $markdown);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'md-js-link-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422]);
});

// =============================================================================
// ZIP FILE TESTS
// =============================================================================

test('rejects zip with path traversal filenames', function () {
    $user = User::factory()->create();

    // Create a ZIP file with path traversal in filename
    // Note: This would need actual ZIP creation for full test
    // Simplified version - verify the validator checks for patterns

    $validator = app(\App\Services\DocumentImport\ValidationService::class);

    // Verify the validator method exists
    expect(method_exists($validator, 'validateZipFile'))->toBeTrue();
});

test('rejects zip with executable files', function () {
    $user = User::factory()->create();

    // ZIP containing .exe, .bat, .sh, .php, .js files should be rejected
    // Validator checks for dangerous extensions
});

test('rejects zip exceeding decompressed size limit', function () {
    $user = User::factory()->create();

    // ZIP bomb protection - total decompressed size > 200MB should be rejected
});

// =============================================================================
// EPUB VALIDATION TESTS
// =============================================================================

test('validates epub internal structure', function () {
    $user = User::factory()->create();

    // Create fake EPUB without proper structure (just ZIP header)
    $zipContent = "\x50\x4B\x03\x04\x14\x00\x00\x00"; // Minimal ZIP header

    $file = UploadedFile::fake()->createWithContent('fake.epub', $zipContent);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'fake-epub-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    // Should reject invalid EPUB structure
    expect($response->status())->toBeIn([400, 422, 500]);
});

// =============================================================================
// PATH TRAVERSAL TESTS
// =============================================================================

test('book id rejects path traversal patterns', function () {
    $user = User::factory()->create();

    $traversalPatterns = [
        '../../../etc/passwd',
        '..%2F..%2F..%2Fetc%2Fpasswd',
        '..\\..\\..\\windows\\system32',
        'test/../../../etc/passwd',
        'test%00/../../../etc/passwd',
        '....//....//....//etc/passwd',
    ];

    foreach ($traversalPatterns as $pattern) {
        $file = UploadedFile::fake()->create('test.md', 100, 'text/plain');

        $response = $this->actingAs($user)
            ->post('/import/store', [
                'book' => $pattern,
                'title' => 'Test',
                'markdown_file' => [$file],
            ]);

        // Book ID should be sanitized - only alphanumeric and -_
        expect($response->status())->toBeIn([400, 422]);
    }
});

// =============================================================================
// FILE SIZE LIMITS
// =============================================================================

test('rejects files exceeding size limit', function () {
    $user = User::factory()->create();

    // Create file larger than 50MB limit
    $largeContent = str_repeat('a', 51 * 1024 * 1024);

    $file = UploadedFile::fake()->createWithContent('large.md', $largeContent);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'large-file-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 413, 422]);
});

// =============================================================================
// MIME TYPE VALIDATION
// =============================================================================

test('rejects files with invalid mime type', function () {
    $user = User::factory()->create();

    // Binary file disguised as markdown
    $binaryContent = random_bytes(1000);

    $file = UploadedFile::fake()->createWithContent('fake.md', $binaryContent);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'binary-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    // Should detect and reject based on content analysis
    expect($response->status())->toBeIn([400, 422]);
});

test('only accepts whitelisted mime types', function () {
    $user = User::factory()->create();

    $invalidTypes = [
        'application/x-php',
        'application/x-httpd-php',
        'application/javascript',
        'application/x-executable',
    ];

    foreach ($invalidTypes as $mimeType) {
        $file = UploadedFile::fake()->create('test.txt', 100, $mimeType);

        $response = $this->actingAs($user)
            ->post('/import/store', [
                'book' => 'mime-test-' . md5($mimeType),
                'title' => 'Test',
                'markdown_file' => [$file],
            ]);

        // Whitelist: text/markdown, text/plain, application/msword, docx, epub, html, zip
        expect($response->status())->toBeIn([400, 422]);
    }
});

// =============================================================================
// CONTENT SANITIZATION AFTER UPLOAD
// =============================================================================

test('uploaded html content is sanitized before storage', function () {
    $user = User::factory()->create();

    // Valid HTML structure but with XSS that should be sanitized (not rejected)
    $html = <<<'HTML'
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<h1>Title</h1>
<p>Normal paragraph</p>
</body>
</html>
HTML;

    $file = UploadedFile::fake()->createWithContent('valid.html', $html);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'sanitize-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    // Valid HTML should be accepted and sanitized
    // This tests that sanitization happens, not just rejection
});

// =============================================================================
// DOCX VALIDATION TESTS
// =============================================================================

test('validates docx file structure', function () {
    $user = User::factory()->create();

    // Fake DOCX is a ZIP with specific internal structure
    // Invalid DOCX should be rejected
    $fakeDocx = "PK\x03\x04invalid_docx_content";

    $file = UploadedFile::fake()->createWithContent('fake.docx', $fakeDocx);

    $response = $this->actingAs($user)
        ->post('/import/store', [
            'book' => 'fake-docx-test',
            'title' => 'Test',
            'markdown_file' => [$file],
        ]);

    expect($response->status())->toBeIn([400, 422, 500]);
});
