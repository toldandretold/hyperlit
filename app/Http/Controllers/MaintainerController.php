<?php

namespace App\Http\Controllers;

use App\Console\Commands\BookExport;
use App\Models\ConversionFlag;
use App\Services\Conversion\ReconvertQueue;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
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
    public function resolve(Request $request, string $book, ReconvertQueue $queue)
    {
        $data = $request->validate([
            'resolution' => 'required|string|in:reconverted,refetched,dismissed',
        ]);

        $book = $this->cleanBookId($book);
        $count = ConversionFlag::resolveFor($book, $data['resolution']);

        // Human approval doubles as the listing gate for harvested versions
        // (minted public+unlisted until someone has actually looked at them).
        $listed = $queue->promoteApprovedHarvest($book);

        return response()->json(['resolved' => $count, 'listed' => $listed]);
    }

    /**
     * POST /api/maintainer/conversion/flags/{book}/note {note} — the maintainer's
     * own diagnosis, written from the triage page's detail strip. Stored in the
     * open flags' details (maintainer_note), so it rides the case bundle's
     * conversion_flags into local dev — the LLM assessing the case reads the
     * USER's complaint and the MAINTAINER's read of it side by side. An empty
     * note clears it.
     */
    public function note(Request $request, string $book)
    {
        $data = $request->validate(['note' => 'present|nullable|string|max:4000']);
        $note = trim((string) ($data['note'] ?? ''));

        $book = $this->cleanBookId($book);
        $flags = ConversionFlag::where('book', $book)->where('status', 'open')->get();

        // No flag yet? Open one. The journal-import console notes lanes nobody has reported —
        // you spotted the bad conversion yourself — and a note with nowhere to live is a note
        // that never reaches the bundle. Writing it as a `manual` flag both gives it a home and
        // puts the lane in the review queue, which is where a known-bad conversion belongs.
        if ($flags->isEmpty()) {
            if ($note === '') {
                return response()->json(['saved' => 0, 'note' => null]);
            }
            if (! DB::connection('pgsql_admin')->table('library')->where('book', $book)->exists()) {
                return response()->json(['message' => 'Book not found.'], 404);
            }

            $flags = collect([ConversionFlag::create([
                'book'    => $book,
                'source'  => ConversionFlag::SOURCE_MANUAL,
                'reason'  => 'Maintainer note',
                'status'  => 'open',
                'details' => [],
            ])]);
        }

        foreach ($flags as $flag) {
            $details = $flag->details ?? [];
            if ($note === '') {
                unset($details['maintainer_note'], $details['noted_by'], $details['noted_at']);
            } else {
                $details['maintainer_note'] = $note;
                $details['noted_by'] = $request->user()?->name;
                $details['noted_at'] = now()->toIso8601String();
            }
            $flag->details = $details;
            $flag->save();
        }

        return response()->json(['saved' => $flags->count(), 'note' => $note !== '' ? $note : null]);
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

        // Scrape-acquired books have no original.* — their ground truth is the
        // raw fetched page; paste-glitch reports leave the pasted clipboard
        // payload. Both deliberately NOT named original.html so reconvert can't
        // route them through the wrong engine. Show them in the side pane.
        foreach (['fetched_page.html', 'pasted_page.html'] as $name) {
            $path = "{$dir}/{$name}";
            if (File::exists($path)) {
                return response()->file($path, [
                    'Content-Type'        => 'text/html; charset=UTF-8',
                    'Content-Disposition' => 'inline; filename="' . $book . '-' . str_replace('_', '-', $name) . '"',
                    'Cache-Control'       => 'private, no-store',
                ]);
            }
        }

        return response()->json(['message' => 'No original source file on disk.'], 404);
    }

    /**
     * GET /api/maintainer/conversion/export/{book}?kind=conversion|harvest —
     * build the case bundle (book:export) and stream it down: the "⤓ conversion glitch"
     * / "⤓ harvest glitch" buttons. The same tarball pull_case.sh fetches over
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

        // Which console exported it. Recorded in the manifest so the importing side knows the
        // case came off a journal lane rather than the generic conversion queue — which changes
        // what you look at first for a harvest case.
        $origin = (string) $request->query('origin', '');
        if (preg_match('/^[a-z-]{1,32}$/', $origin)) {
            $args['--origin'] = $origin;
        }

        $exit = Artisan::call('book:export', $args);
        if ($exit !== 0) {
            return response()->json(['message' => 'Export failed — see logs.'], 422);
        }

        $tarball = storage_path("app/book-exports/{$book}.tar.gz");
        if (!File::exists($tarball)) {
            return response()->json(['message' => 'Export produced no bundle.'], 500);
        }

        // Stamp the open flags with what was exported — the queue list renders a
        // "⤓ conversion / ⤓ harvest" marker from this, so the maintainer can see
        // which cases they already pulled down. When no explicit kind was passed,
        // read the auto-detected one from the manifest of the bundle just built.
        if (!in_array($kind, [BookExport::KIND_CONVERSION, BookExport::KIND_HARVEST], true)) {
            $probe = new \Symfony\Component\Process\Process(['tar', '-xzOf', $tarball, './manifest.json']);
            $probe->run();
            $kind = (string) (json_decode($probe->getOutput(), true)['case_kind'] ?? BookExport::KIND_CONVERSION);
        }
        foreach (ConversionFlag::where('book', $book)->where('status', 'open')->get() as $flag) {
            $flag->details = array_merge($flag->details ?? [], [
                'exported_kind' => $kind,
                'exported_at'   => now()->toIso8601String(),
            ]);
            $flag->save();
        }

        return response()->download($tarball, "{$book}.tar.gz");
    }

    private function cleanBookId(string $book): string
    {
        return preg_replace('/[^A-Za-z0-9_-]/', '', $book);
    }
}
