<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\ImportController;
use App\Http\Controllers\UrlImportController;
use App\Mcp\Support\InternalCall;
use App\Mcp\TokenAbilities;
use App\Services\SourceImport\SingleWorkImporter;
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
 *  - url: a work IDENTIFIER, resolved server-side. arXiv (ar5iv HTML) and
 *    Project Gutenberg (EPUB) fetch one known file. A DOI or OpenAlex work id
 *    goes to SingleWorkImporter — the open-access acquisition ladder the source
 *    harvester uses — and lands as the shared commons copy, or a private copy
 *    when that copy may not be hosted publicly. Anything else (a plain web
 *    page) is NOT fetched: it is refused as an unrecognised identifier.
 *
 * PDFs are the only paid path (OCR), so they take an estimate → confirm flow:
 * call once to get the price + a confirm_token, call again WITH the token (and
 * the `spend` ability) to run it. For an uploaded PDF the estimate comes back
 * at once; for a DOI / OpenAlex import it surfaces through import_status
 * (status awaiting_confirmation) once the ladder has found a PDF. All imports
 * are async — the returned id is polled with import_status.
 */
#[IsIdempotent(false)]
class ImportDocumentTool extends HyperlitTool
{
    protected string $ability = TokenAbilities::IMPORT;

    /** Base64 payloads above this are refused — large files belong in the web uploader. */
    private const MAX_DECODED_BYTES = 10 * 1024 * 1024;

    private const NON_PDF_EXT = ['md', 'markdown', 'txt', 'docx', 'doc', 'odt', 'rtf', 'epub', 'html', 'htm'];

    protected string $name = 'import_document';

    protected string $description = 'Import a document into the user\'s library. PREFERRED: pass the full text as `content` (Markdown or HTML) — e.g. the article text you fetched/cleaned from a journal page — which goes through the robust file-import pipeline. Also accepts base64 file bytes (docx/epub/pdf/…) via file_base64, or a work identifier via `url`: a DOI or an OpenAlex work id (the `doi` / `openalex_id` that search_sources returns) runs Hyperlit\'s open-access acquisition ladder — every free copy known to OpenAlex, Unpaywall, CORE, Semantic Scholar and Europe PMC — and so does not need you to fetch the text yourself; arXiv links and Project Gutenberg book URLs (gutenberg.org/ebooks/<id>) are fetched directly. A DOI/OpenAlex import can still fail (no open copy exists, or every copy is walled) and import_status then says why. An ordinary web page URL is NOT supported — fetch it yourself and pass `content`. Returns an id to poll with import_status. PDFs cost credits (OCR) and use the estimate→confirm flow.';

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
            'url' => $schema->string()->description('A work identifier: a DOI (bare or doi.org URL), an OpenAlex work id (W… or openalex.org/W…), an arXiv URL/id, or a Project Gutenberg book URL. Metadata is derived server-side. A DOI/OpenAlex import returns the shared commons copy when one can be hosted, otherwise a private copy for the user. Not for arbitrary web pages — use content for those.'),
            'confirm_token' => $schema->string()->description('For PDFs only: the token from the estimate (returned by the first call for an uploaded PDF, or by import_status for a DOI/OpenAlex import that found a PDF), to confirm the OCR charge. Pass it alone to confirm a DOI/OpenAlex import.'),
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

        // Confirm leg of a DOI / OpenAlex import that paused on a PDF: the token alone
        // identifies it (the PDF is already on the server, so there is no file to resend).
        $confirmToken = trim((string) $request->get('confirm_token', ''));
        if ($confirmToken !== '' && app(SingleWorkImporter::class)->ownsConfirmToken($confirmToken, $this->user($request))) {
            return $this->confirmWorkImport($request, $confirmToken);
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
            // DOI / OpenAlex lane: pause for an OCR estimate instead of billing unasked.
            'surface' => SingleWorkImporter::SURFACE_MCP,
        ], $this->user($request));

        $json = is_array($result['json']) ? $result['json'] : [];
        if (($json['ok'] ?? false) !== true) {
            return Response::error($this->urlImportFailure($json));
        }

        // Already readable — the commons copy, or a copy the user owns. Nothing was fetched.
        if (($json['existing'] ?? false) === true) {
            return Response::json([
                'book' => $json['bookId'],
                'status' => 'complete',
                'already_in_hyperlit' => true,
                'outcome' => $json['outcome'] ?? null,
                'note' => ($json['outcome'] ?? null) === 'commons'
                    ? 'This work is already in Hyperlit as a shared commons copy — read it with get_book / read_book, or add it to a shelf with modify_shelf.'
                    : 'The user already has their own copy of this work — read it with get_book / read_book.',
            ]);
        }

        if (($json['async'] ?? false) === true) {
            return Response::json([
                'import' => $json['import'],
                'status' => 'queued',
                'next' => 'Poll import_status with this id (pass it as `book`). When complete it returns the real book id and whether it is the shared commons copy or a private copy. If it reports awaiting_confirmation, an open copy was found as a PDF: relay the OCR estimate to the user, then call import_document with just the confirm_token.',
            ]);
        }

        return Response::json([
            'book' => $json['bookId'] ?? $book,
            'status' => 'queued',
            'next' => 'Poll import_status with this book id.',
        ]);
    }

    /**
     * Say WHY a url import failed. The old `URL import failed: <code>` threw away the
     * controller's reason and the publisher link, so an agent could not tell "no open copy
     * exists" from "the publisher walled us" from "that is not an identifier".
     *
     * @param  array<string, mixed>  $json
     */
    private function urlImportFailure(array $json): string
    {
        $error = (string) ($json['error'] ?? 'unknown_error');
        $source = ! empty($json['source_url']) ? " Source: {$json['source_url']}." : '';

        return match ($error) {
            'unrecognised_identifier' => 'That is not a recognised work identifier. `url` takes a DOI, an OpenAlex work id (W…), an arXiv link or a Project Gutenberg book URL — not an ordinary web page. For a web page, fetch the text yourself and pass it as `content`.',
            'metadata_unavailable', 'metadata_unavailable_but_canonical_exists' => 'OpenAlex has no record for that identifier, so the work could not be resolved. Check the DOI / id (search_sources returns valid ones), or import the text via `content`.',
            'closed_access_requires_upload' => 'No open-access copy of this work is listed by OpenAlex, Unpaywall, CORE or Semantic Scholar, so it cannot be fetched automatically. If the user has the PDF, import it with file_base64.'.$source,
            'content_fetch_failed' => 'The file for this work could not be downloaded ('.($json['reason'] ?? 'unknown reason').').'.$source,
            'book_id_taken' => 'A book id collision occurred; retry.',
            'invalid_session' => 'The session is not valid for importing.',
            default => "URL import failed: {$error}.".$source,
        };
    }

    private function confirmWorkImport(Request $request, string $confirmToken): Response
    {
        $user = $this->user($request);
        $spendToken = $user->currentAccessToken();
        if ($spendToken instanceof \Laravel\Sanctum\PersonalAccessToken && ! $spendToken->can(TokenAbilities::SPEND)) {
            return Response::error("Confirming a paid PDF import needs the 'spend' ability — the user can mint a token with it via the user button → Data sovereignty → MCP for AI access → Connect an AI.");
        }
        if (! app(\App\Services\BillingService::class)->canProceed($user)) {
            return Response::error('Insufficient balance for OCR. The user can top up credits in Account → Money.');
        }

        $result = app(SingleWorkImporter::class)->confirm($confirmToken, $user);
        if (! $result['ok']) {
            return Response::error('That confirm_token is unknown or no longer awaiting confirmation — poll import_status for the current state.');
        }

        return Response::json([
            'import' => $result['import'],
            'status' => 'queued',
            'charged' => 'OCR will be billed per page after conversion succeeds.',
            'next' => 'Poll import_status with this id.',
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
