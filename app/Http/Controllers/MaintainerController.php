<?php

namespace App\Http\Controllers;

use App\Models\ConversionFlag;
use App\Services\Conversion\ReconvertQueue;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\File;

/**
 * The /maintainer triage page — the human-in-the-loop seat of the
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
    /** GET /maintainer — the standalone triage page (docuverse pattern). */
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

    /** GET /api/maintainer/flags — the queue, grouped per book. */
    public function flags(ReconvertQueue $queue)
    {
        return response()->json(['entries' => $queue->openFlagsGrouped()]);
    }

    /** POST /api/maintainer/flags/{book}/resolve {resolution} */
    public function resolve(Request $request, string $book)
    {
        $data = $request->validate([
            'resolution' => 'required|string|in:reconverted,refetched,dismissed',
        ]);

        $count = ConversionFlag::resolveFor($this->cleanBookId($book), $data['resolution']);

        return response()->json(['resolved' => $count]);
    }

    /**
     * GET /api/maintainer/original/{book} — stream the book's original source
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
     * GET /api/maintainer/export/{book} — build the case bundle (book:export)
     * and stream it down: the "⤓ dev bundle" button. The same tarball
     * pull_case.sh fetches over ssh.
     */
    public function export(string $book)
    {
        $book = $this->cleanBookId($book);

        $exit = Artisan::call('book:export', ['book' => $book]);
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
