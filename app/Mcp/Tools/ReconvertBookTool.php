<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\ImportController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Http\UploadedFile;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Re-run an EXISTING book through the conversion pipeline — same book id, same
 * URL, same place. Two modes:
 *  - no new content: reconverts the book's cached source (use after a pipeline
 *    improvement, or to retry a bad conversion).
 *  - new content/file: REPLACES the source, then reconverts (the reader's
 *    "re-upload" dropzone). Replacing a source with a PDF bills OCR.
 *
 * Unlike import_document this never mints a new book, so the book keeps its
 * annotations, likes and links.
 */
#[IsIdempotent(false)]
class ReconvertBookTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::IMPORT;

    private const NON_PDF_EXT = ['md', 'markdown', 'txt', 'docx', 'doc', 'odt', 'rtf', 'epub', 'html', 'htm'];

    private const MAX_DECODED_BYTES = 10 * 1024 * 1024;

    protected string $name = 'reconvert_book';

    protected string $description = 'Re-run an EXISTING book through conversion, keeping its id/URL/annotations. With no content, reconverts the cached source (e.g. after a pipeline fix). With `content` (Markdown/HTML) or `file_base64`, REPLACES the source then reconverts. Owner only. Returns the book id to poll with import_status. Replacing with a PDF bills OCR (needs the spend ability).';

    public function schema(JsonSchema $schema): array
    {
        return [
            'book' => $schema->string()->required()->description('The existing book id (book_…) or URL slug.'),
            'content' => $schema->string()->description('Optional NEW full text (Markdown, or HTML with format=html) to replace the source.'),
            'format' => $schema->string()->enum(['markdown', 'html'])->description('How to interpret `content`. Default markdown.'),
            'file_base64' => $schema->string()->description('Optional NEW file bytes (docx/epub/pdf/…) to replace the source. Provide with filename.'),
            'filename' => $schema->string()->description('Filename incl. extension for file_base64.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        $request->validate(['book' => 'required|string']);
        [$bookId, $refusal] = $this->resolveBook((string) $request->get('book'));
        if ($refusal) {
            return $refusal;
        }

        $user = $this->user($request);
        $files = [];

        // Optional source replacement.
        $content = (string) $request->get('content', '');
        $base64 = (string) $request->get('file_base64', '');
        if (trim($content) !== '') {
            $ext = $request->get('format') === 'html' ? 'html' : 'md';
            if (strlen($content) > self::MAX_DECODED_BYTES) {
                return Response::error('content exceeds the 10MB limit.');
            }
            $files = ['file' => [$this->tempUpload('pasted.'.$ext, $content)]];
        } elseif ($base64 !== '') {
            $filename = trim((string) $request->get('filename', ''));
            if ($filename === '') {
                return Response::error('file_base64 needs a filename (its extension selects the parser).');
            }
            $bytes = base64_decode($base64, true);
            if ($bytes === false) {
                return Response::error('file_base64 is not valid base64.');
            }
            if (strlen($bytes) > self::MAX_DECODED_BYTES) {
                return Response::error('File exceeds the 10MB MCP limit.');
            }
            $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
            if ($ext !== 'pdf' && ! in_array($ext, self::NON_PDF_EXT, true)) {
                return Response::error('Unsupported file type .'.$ext.'.');
            }
            // reconvert() takes a single 'file'.
            $files = ['file' => [$this->tempUpload($filename, $bytes)]];
        }

        $result = InternalCall::call(ImportController::class, 'reconvert', [], $user, [$bookId], $files);

        if ($result['status'] === 402) {
            return Response::error('Insufficient balance to OCR the replacement PDF. Top up in Account → Money.');
        }
        if ($result['status'] === 409) {
            return Response::error('A reconversion of this book is already in progress — poll import_status.');
        }
        if ($error = $this->errorFrom($result, 'reconvert this book')) {
            return $error;
        }
        if (($result['json']['success'] ?? false) !== true) {
            return Response::error($result['json']['message'] ?? 'Reconversion was not started.');
        }

        return Response::json([
            'book' => $bookId,
            'status' => $result['json']['status'] ?? 'processing',
            'replaced_source' => $files !== [],
            'next' => 'Poll import_status with this book id; the URL and annotations are unchanged.',
        ]);
    }

    private function tempUpload(string $filename, string $bytes): UploadedFile
    {
        $tmp = tempnam(sys_get_temp_dir(), 'mcprec_');
        file_put_contents($tmp, $bytes);

        return new UploadedFile($tmp, $filename, null, null, true);
    }
}
