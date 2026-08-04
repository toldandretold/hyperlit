<?php

namespace App\Http\Controllers;

use App\Console\Commands\BookExport;
use App\Models\ConversionFlag;
use App\Services\Conversion\ReconvertQueue;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\File;

/**
 * The /maintainer/conversion triage page — the human-in-the-loop seat of the
 * bad-conversion pipeline. Left: open conversion_flags; middle: the flagged
 * book in the REAL reader (same-origin iframe — see SecurityHeaders'
 * SAMEORIGIN note); right: the original source file (browser-native PDF
 * viewer); bottom: dev-bundle download / reconvert / resolve actions.
 *
 * Web route: admin checked in-controller, non-admins get 404 (the page's
 * existence isn't advertised — mirrors /dev/conversion-tests). API routes:
 * behind the auth:sanctum + admin middleware group in routes/api.php.
 */
class MaintainerController extends Controller
{
    /** GET /maintainer/conversion — the standalone triage page (docuverse pattern). */
    public function show(Request $request)
    {
        $user = $request->user();
        if (!$user || !$user->isAdmin()) {
            abort(404);
        }

        return view('maintainer', [
            'deepLinkBook' => $this->cleanBookId((string) $request->query('book', '')) ?: null,
        ]);
    }

    /** GET /api/maintainer/conversion/flags — the queue, grouped per book. */
    public function flags(ReconvertQueue $queue)
    {
        return response()->json(['entries' => $queue->openFlagsGrouped()]);
    }

    /** POST /api/maintainer/conversion/flags/{book}/resolve {resolution} */
    public function resolve(Request $request, string $book)
    {
        $data = $request->validate([
            'resolution' => 'required|string|in:reconverted,refetched,dismissed',
        ]);

        $count = ConversionFlag::resolveFor($this->cleanBookId($book), $data['resolution']);

        return response()->json(['resolved' => $count]);
    }

    /**
     * POST /api/maintainer/conversion/flags/{book}/retract {force?} — the 🗑 retract
     * button: this harvested version should never have been approved (paywalled
     * landing page, captcha, contents-only). Deletes the version book, clears +
     * re-resolves the canonical pointer, closes the flags as `retracted`. The
     * guards (system-acquired only; body-PRESENT refuses without force) live in
     * HarvestRetraction — a 422 with refusal=body_present is the "this might be
     * a real book, confirm again" signal the frontend re-prompts on.
     */
    public function retract(Request $request, string $book, \App\Services\Conversion\HarvestRetraction $retraction)
    {
        $data = $request->validate(['force' => 'sometimes|boolean']);

        $result = $retraction->retract($this->cleanBookId($book), (bool) ($data['force'] ?? false));
        if (!$result['allowed']) {
            return response()->json([
                'message'      => match ($result['refusal']) {
                    \App\Services\Conversion\HarvestRetraction::REFUSED_BODY_PRESENT
                        => "The stored text looks like a REAL body ({$result['prose_blocks']} prose blocks) — retract anyway?",
                    \App\Services\Conversion\HarvestRetraction::REFUSED_NOT_ACQUIRED
                        => 'Not a system-acquired version — user uploads are never retractable from here.',
                    default => 'Book not found.',
                },
                'refusal'      => $result['refusal'],
                'prose_blocks' => $result['prose_blocks'],
            ], $result['refusal'] === \App\Services\Conversion\HarvestRetraction::REFUSED_NOT_FOUND ? 404 : 422);
        }

        return response()->json([
            'retracted' => true,
            'resolved'  => $result['flags_resolved'] ?? 0,
        ]);
    }

    /**
     * GET /api/maintainer/conversion/original/{book} — stream the book's original source
     * file for the right-hand column. PDFs/HTML/MD render natively in an
     * iframe; binary formats download.
     */
    public function original(string $book)
    {
        $book = $this->cleanBookId($book);
        $dir = resource_path("markdown/{$book}");

        // Same priority order as ImportController::reconvertInfo.
        $types = [
            'pdf'  => 'application/pdf',
            'html' => 'text/html; charset=UTF-8',
            'md'   => 'text/plain; charset=UTF-8',
            'epub' => 'application/octet-stream',
            'docx' => 'application/octet-stream',
            'doc'  => 'application/octet-stream',
            'odt'  => 'application/octet-stream',
            'rtf'  => 'application/octet-stream',
        ];
        foreach ($types as $ext => $mime) {
            $path = "{$dir}/original.{$ext}";
            if (File::exists($path)) {
                return response()->file($path, [
                    'Content-Type'        => $mime,
                    // inline: the triage iframe renders it; browsers fall back
                    // to download for the octet-stream formats anyway.
                    'Content-Disposition' => 'inline; filename="' . $book . '-original.' . $ext . '"',
                    'Cache-Control'       => 'private, no-store',
                ]);
            }
        }

        return response()->json(['message' => 'No original source file on disk.'], 404);
    }

    /**
     * GET /api/maintainer/conversion/export/{book}?kind=conversion|harvest —
     * build the case bundle (book:export) and stream it down: the "⤓ dev bundle"
     * / "⤓ harvest bundle" buttons. The same tarball pull_case.sh fetches over
     * ssh. `kind` is optional — book:export auto-detects it from the book, and
     * the param only exists to override a wrong guess.
     */
    public function export(Request $request, string $book)
    {
        $book = $this->cleanBookId($book);

        $kind = (string) $request->query('kind', '');
        $args = ['book' => $book];
        if (in_array($kind, [BookExport::KIND_CONVERSION, BookExport::KIND_HARVEST], true)) {
            $args['--kind'] = $kind;
        }

        $exit = Artisan::call('book:export', $args);
        if ($exit !== 0) {
            return response()->json(['message' => 'Export failed — see logs.'], 422);
        }

        $tarball = storage_path("app/book-exports/{$book}.tar.gz");
        if (!File::exists($tarball)) {
            return response()->json(['message' => 'Export produced no bundle.'], 500);
        }

        return response()->download($tarball, "{$book}.tar.gz");
    }

    private function cleanBookId(string $book): string
    {
        return preg_replace('/[^A-Za-z0-9_-]/', '', $book);
    }
}
