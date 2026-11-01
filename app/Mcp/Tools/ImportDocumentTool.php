<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\ImportController;
use App\Http\Controllers\UrlImportController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;

/**
 * Import a document into the user's library. Two inputs:
 *  - file_base64 + filename: a base64-encoded document (md/docx/epub/html/
 *    txt/rtf/odt or an image), capped ~10MB for MCP-arg practicality.
 *  - url: a web page / open-access record, resolved server-side.
 *
 * PDFs are the only paid path (OCR), so they take an estimate → confirm flow:
 * call once to get the price + a confirm_token, call again WITH the token (and
 * the `spend` ability) to run it. All imports are async — the returned book id
 * is polled with import_status.
 */
#[IsIdempotent(false)]
class ImportDocumentTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::IMPORT;

    /** Base64 payloads above this are refused — large files belong in the web uploader. */
    private const MAX_DECODED_BYTES = 10 * 1024 * 1024;

    private const NON_PDF_EXT = ['md', 'markdown', 'txt', 'docx', 'doc', 'odt', 'rtf', 'epub', 'html', 'htm'];

    protected string $name = 'import_document';

    protected string $description = 'Import a document into the user\'s library. PREFERRED: pass the full text as `content` (Markdown or HTML) — e.g. the article text you fetched/cleaned from a journal page — which goes through the robust file-import pipeline. Also accepts base64 file bytes (docx/epub/pdf/…) via file_base64, or a `url` (least reliable — the URL fetcher is weak; prefer content/file). Returns a book id to poll with import_status. PDFs cost credits (OCR) and use the estimate→confirm flow.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'title' => $schema->string()->description('Document title. Required for content/file imports; URL imports derive it.'),
            'author' => $schema->string()->description('Author(s), "; "-separated.'),
            'year' => $schema->integer()->description('Publication year.'),
            'content' => $schema->string()->description('The full document text as Markdown (or HTML with format=html). The best path — pass the article text directly, no encoding. ≤10MB.'),
            'format' => $schema->string()->enum(['markdown', 'html'])->description('How to interpret `content`. Default markdown.'),
            'file_base64' => $schema->string()->description('Base64-encoded file bytes (for binary formats: docx/epub/pdf/odt/rtf). Provide with filename.'),
            'filename' => $schema->string()->description('Original filename incl. extension (drives the parser), for file_base64.'),
            'url' => $schema->string()->description('A web/article/open-access URL. LAST RESORT — the fetcher is unreliable; prefer content or file_base64.'),
            'confirm_token' => $schema->string()->description('For PDFs only: the token returned by the first (estimate) call, to confirm the charge.'),
            'force' => $schema->boolean()->description('Skip the "already in Hyperlit?" duplicate check and import anyway. Default false.'),
        ];
    }

    public function handle(Request $request): Response
    {
        if ($denied = $this->denyUnlessAble($request)) {
            return $denied;
        }

        // Dedup: by default refuse to import a title that already exists in the
        // library (the user's own or public), returning the match so the model
        // can reuse it instead of creating a duplicate. A PDF confirm leg skips
        // this (the estimate already passed it).
        if (! $request->boolean('force') && trim((string) $request->get('confirm_token', '')) === '') {
            if ($dupe = $this->duplicateCheck($request)) {
                return $dupe;
            }
        }

        // PREFERRED: raw text/markdown/html handed straight to the file
        // pipeline — no base64, bypasses the weak URL fetcher entirely.
        $content = (string) $request->get('content', '');
        if (trim($content) !== '') {
            if (trim((string) $request->get('title', '')) === '') {
                return Response::error('A `title` is required when importing `content` (it becomes the work\'s title).');
            }
            $format = $request->get('format') === 'html' ? 'html' : 'md';
            if (strlen($content) > self::MAX_DECODED_BYTES) {
                return Response::error('content exceeds the 10MB limit — split it or use the web uploader.');
            }
            // Dead-arrow guard: the import pipeline preserves hypercite anchor
            // HTML but wires NOTHING — no citedIN, no notification, no
            // connection edge — so an embedded ↗ renders as a link whose source
            // book never learns it is cited. Refuse rather than mint dead
            // arrows; the two-way wiring is cite_passage's job, after import.
            if (preg_match('/#hypercite_|class="open-icon"|<u[^>]+id="hypercite_/i', $content)) {
                return Response::error(
                    'content contains hypercite markup (↗ anchors / #hypercite_ links), which the import pipeline '
                    .'cannot wire up — it would produce dead one-way arrows. Import the text WITHOUT citation markup, '
                    .'then add each citation with cite_passage (it completes the two-way link).'
                );
            }
            return $this->importFile($request, 'pasted.'.$format, $format, $content);
        }

        $url = trim((string) $request->get('url', ''));
        if ($url !== '') {
            return $this->importUrl($request, $url);
        }

        $base64 = (string) $request->get('file_base64', '');
        $filename = trim((string) $request->get('filename', ''));
        if ($base64 === '' || $filename === '') {
            return Response::error('Provide `content` (full text — preferred), or `file_base64` + `filename`, or `url`.');
        }

        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        $bytes = base64_decode($base64, true);
        if ($bytes === false) {
            return Response::error('file_base64 is not valid base64.');
        }
        if (strlen($bytes) > self::MAX_DECODED_BYTES) {
            return Response::error('File exceeds the 10MB MCP limit — use the web uploader for larger files.');
        }

        return $ext === 'pdf'
            ? $this->importPdf($request, $filename, $bytes)
            : $this->importFile($request, $filename, $ext, $bytes);
    }

    /**
     * If a book with a very similar title already exists (RLS-visible), return
     * it so the model reuses it rather than importing a duplicate. Null = clear
     * to import. Best-effort: a lookup failure never blocks an import.
     */
    private function duplicateCheck(Request $request): ?Response
    {
        $title = trim((string) $request->get('title', ''));
        if (mb_strlen($title) < 6) {
            return null; // too short to match meaningfully (URL imports derive the title later)
        }

        try {
            $result = InternalCall::call(\App\Http\Controllers\SearchController::class, 'searchLibrary', [
                'q' => $title, 'limit' => 5,
            ], $this->user($request));
            $results = $result['json']['results'] ?? [];
        } catch (\Throwable) {
            return null;
        }

        $norm = fn (string $s) => preg_replace('/[^a-z0-9]+/', ' ', mb_strtolower(trim($s)));
        $want = $norm($title);
        foreach ($results as $r) {
            $cand = $norm((string) ($r['title'] ?? ''));
            if ($cand !== '' && ($cand === $want || str_contains($cand, $want) || str_contains($want, $cand))) {
                return Response::json([
                    'already_exists' => true,
                    'match' => ['book' => $r['book'] ?? $r['id'] ?? null, 'title' => $r['title'] ?? null, 'author' => $r['author'] ?? null],
                    'note' => 'A book with this title is already in Hyperlit — reuse it (add it to a shelf / read it) instead of re-importing. To import anyway, call again with force:true.',
                ]);
            }
        }

        return null;
    }

    private function importUrl(Request $request, string $url): Response
    {
        $book = 'book_'.now()->getTimestampMs();
        $result = InternalCall::call(UrlImportController::class, 'commit', [
            'url' => $url,
            'book' => $book,
        ], $this->user($request));

        $json = is_array($result['json']) ? $result['json'] : [];
        if (($json['ok'] ?? false) !== true) {
            $error = $json['error'] ?? 'unknown_error';
            return Response::error(match ($error) {
                'closed_access_requires_upload' => 'This work is not open-access and can\'t be auto-fetched — download the PDF and import it with file_base64 instead.',
                'book_id_taken' => 'A book id collision occurred; retry.',
                default => "URL import failed: {$error}.",
            });
        }

        return Response::json([
            'book' => $json['book'] ?? $book,
            'status' => 'queued',
            'next' => 'Poll import_status with this book id.',
        ]);
    }

    private function importFile(Request $request, string $filename, string $ext, string $bytes): Response
    {
        if (! in_array($ext, self::NON_PDF_EXT, true)) {
            return Response::error('Unsupported file type .'.$ext.'. Supported: '.implode(', ', self::NON_PDF_EXT).', or pdf.');
        }

        $upload = $this->tempUpload($filename, $bytes);
        $book = 'book_'.now()->getTimestampMs();

        $result = InternalCall::call(ImportController::class, 'store', [
            'book' => $book,
            'title' => (string) $request->get('title', pathinfo($filename, PATHINFO_FILENAME)),
            'author' => $request->get('author'),
            'year' => $request->get('year'),
            'imported_via' => 'mcp',
        ], $this->user($request), [], ['markdown_file' => [$upload]]);

        if ($error = $this->errorFrom($result, 'import the document')) {
            return $error;
        }

        return Response::json([
            'book' => $result['json']['bookId'] ?? $book,
            'status' => 'queued',
            'next' => 'Poll import_status with this book id.',
        ]);
    }

    private function importPdf(Request $request, string $filename, string $bytes): Response
    {
        $user = $this->user($request);
        $confirmToken = trim((string) $request->get('confirm_token', ''));

        // Confirm leg: the token must match a stashed estimate for this user,
        // and the `spend` ability is additionally required.
        if ($confirmToken !== '') {
            $stash = Cache::pull('mcp:import:'.$user->id.':'.$confirmToken);
            if (! $stash) {
                return Response::error('That confirm_token is unknown or expired — request a fresh estimate.');
            }
            $spendToken = $user->currentAccessToken();
            if ($spendToken instanceof \Laravel\Sanctum\PersonalAccessToken && ! $spendToken->can(TokenAbilities::SPEND)) {
                return Response::error("Confirming a paid PDF import needs the 'spend' ability — the user can mint a token with it via the user button → Data sovereignty → MCP for AI access → Connect an AI.");
            }

            $upload = $this->tempUpload($stash['filename'], base64_decode($stash['bytes']));
            $result = InternalCall::call(ImportController::class, 'store', [
                'book' => $stash['book'],
                'title' => $stash['title'],
                'author' => $stash['author'],
                'year' => $stash['year'],
                'imported_via' => 'mcp',
            ], $user, [], ['markdown_file' => [$upload]]);

            if ($result['status'] === 402) {
                return Response::error('Insufficient balance for OCR. The user can top up credits in Account → Money.');
            }
            if ($error = $this->errorFrom($result, 'import the PDF')) {
                return $error;
            }

            return Response::json([
                'book' => $result['json']['bookId'] ?? $stash['book'],
                'status' => 'queued',
                'charged' => 'OCR will be billed per page after conversion succeeds.',
                'next' => 'Poll import_status with this book id.',
            ]);
        }

        // Estimate leg: stash the file, return the price and a confirm_token.
        $book = 'book_'.now()->getTimestampMs();
        $pages = $this->countPdfPages($bytes);
        $estimate = $this->estimateOcrCost($user, $pages);
        $token = Str::lower(Str::random(16));

        Cache::put('mcp:import:'.$user->id.':'.$token, [
            'book' => $book,
            'filename' => $filename,
            'bytes' => base64_encode($bytes),
            'title' => (string) $request->get('title', pathinfo($filename, PATHINFO_FILENAME)),
            'author' => $request->get('author'),
            'year' => $request->get('year'),
        ], now()->addMinutes(15));

        return Response::json([
            'requires_confirmation' => true,
            'estimated_pages' => $pages,
            'estimated_cost_usd' => $estimate,
            'balance_usd' => round(app(\App\Services\BillingService::class)->getBalance($user), 2),
            'confirm_token' => $token,
            'note' => 'PDF import runs OCR, billed per page. Call import_document again with this confirm_token (and a token carrying the spend ability) to proceed. The estimate expires in 15 minutes.',
        ]);
    }

    private function tempUpload(string $filename, string $bytes): UploadedFile
    {
        $tmp = tempnam(sys_get_temp_dir(), 'mcpimp_');
        file_put_contents($tmp, $bytes);

        // test:true → skip is_uploaded_file() (this is a crafted, not HTTP, upload).
        return new UploadedFile($tmp, $filename, null, null, true);
    }

    private function countPdfPages(string $bytes): ?int
    {
        try {
            $tmp = tempnam(sys_get_temp_dir(), 'mcppdf_');
            file_put_contents($tmp, $bytes);
            $parser = new \Smalot\PdfParser\Parser();
            $pdf = $parser->parseFile($tmp);
            @unlink($tmp);

            return count($pdf->getPages());
        } catch (\Throwable) {
            return null; // page count is best-effort; the hard 402 backstop remains
        }
    }

    private function estimateOcrCost(\App\Models\User $user, ?int $pages): ?float
    {
        if ($pages === null) {
            return null;
        }
        // Pinned production OCR model rate × the user's tier multiplier.
        $per1k = (float) (config('services.llm.pricing.mistral-ocr-2512.per_1k_pages') ?? 2.00);
        $raw = $pages / 1000 * $per1k;

        return round($raw * $user->getBillingMultiplier(), 2);
    }
}
