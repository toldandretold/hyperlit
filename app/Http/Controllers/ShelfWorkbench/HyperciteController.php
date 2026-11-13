<?php

namespace App\Http\Controllers\ShelfWorkbench;

use App\Http\Controllers\Maintainer\HyperciteConsoleController;
use App\Models\ArchiveSource;
use App\Services\BillingService;
use App\Services\Connections\ConnectionRefresher;
use App\Services\Hypercites\CandidateDetector;
use App\Services\Hypercites\CitedWorksQuery;
use App\Services\Hypercites\HyperciteMinter;
use App\Services\Hypercites\WorkbenchActor;
use App\Services\Shelves\ShelfWorkbenchAccess;
use App\Services\SourceImport\ImportOrchestrator;
use App\Services\SourceImport\SingleWorkImporter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The hypercite workbench for a SHELF OWNER — /a/{slug}/hypercites.
 *
 * Same page, same review loop, same detector and minter as the operator console
 * (/maintainer/hypercites). It EXTENDS that controller on purpose: the actions are not
 * forked, so a fix to the console is a fix here. What differs is only who is asking, and
 * that is expressed in three overrides rather than in copies of the logic:
 *
 *   actor()            a WorkbenchActor bound to this owner and this shelf — every read is
 *                      scoped to the shelf, and every write is refused unless the citing
 *                      book is theirs and the cited one is a system-held work;
 *   detectPreflight()  an estimate to confirm, and a credit check, before a run is queued;
 *   detectIsBilled()   true — the run charges its user for each bibliography scan.
 *
 * Two things the owner does NOT get: auto-approve and bulk import (neither is routed), and
 * the operator's cited-source importer. Importing a cited work goes through
 * SingleWorkImporter — the user-facing, user-billed front door — and lands on the owner's
 * own "Imported works" shelf; the next detect matches against it like any held book.
 *
 * Every API route here sits behind auth:sanctum + `shelf.owner` (RequireShelfOwner), which
 * resolves and authorises the shelf ONCE and hands it over on the request. Nothing in this
 * class reads a shelf id from anywhere else.
 */
class HyperciteController extends HyperciteConsoleController
{
    /* ───────────────────────── Who is asking ───────────────────────── */

    private function shelf(Request $request): object
    {
        return $request->attributes->get('workbenchShelf');
    }

    protected function actor(Request $request): WorkbenchActor
    {
        return WorkbenchActor::shelfOwner((string) $request->user()->name, (string) $this->shelf($request)->id);
    }

    /** The owner's scope: their shelf, bounded to the books they may have scanned. */
    private function ownerScope(Request $request): array
    {
        $shelf = $this->shelf($request);

        return [
            'type'   => 'shelf',
            'column' => 'shelf_id',
            'id'     => $shelf->id,
            'label'  => (string) $shelf->name,
            'viewer' => (string) $request->user()->name,
            'meta'   => [
                'scope_type'   => 'shelf',
                'shelf_id'     => $shelf->id,
                'display_name' => $shelf->name,
                'publisher'    => $shelf->creator,
                'mode'         => 'owner',
            ],
        ];
    }

    protected function detectIsBilled(): bool
    {
        return true;
    }

    /**
     * Before a billed detect is queued: say what it will scan, and require a yes.
     *
     * The estimate is a COUNT, not a price. A bibliography scan is metered LLM usage that
     * depends on how each book's references are written; we have no calibrated per-book
     * figure, and an invented one would be a promise the ledger then breaks. The count of
     * books and references is what we actually know.
     */
    protected function detectPreflight(Request $request, array $scope): ?JsonResponse
    {
        $estimate = $this->scanEstimate($request, $scope);

        if ($estimate['books_to_scan'] > 0 && ! app(BillingService::class)->canProceed($request->user())) {
            return response()->json([
                'message'  => 'Add credit to run detection: '
                    . "{$estimate['books_to_scan']} book(s) on this shelf need a bibliography scan first.",
                'refusal'  => 'insufficient_credit',
                'estimate' => $estimate,
            ], 402);
        }

        if ($estimate['books_to_scan'] > 0 && ! $request->boolean('confirm')) {
            return response()->json(['needs_confirm' => true, 'estimate' => $estimate]);
        }

        return null;
    }

    /**
     * How many of the shelf's books still need a bibliography scan, and how many
     * references those hold.
     *
     * @return array{books:int, books_to_scan:int, references:int}
     */
    private function scanEstimate(Request $request, array $scope): array
    {
        $db = DB::connection('pgsql_admin');
        $books = $db->table('shelf_items as si')
            ->join('library as l', 'l.book', '=', 'si.book')
            ->where('si.shelf_id', $scope['id'])
            ->where('l.has_nodes', true)
            ->where('l.visibility', '!=', 'deleted')
            ->where(fn ($w) => $w->where('l.visibility', 'public')->orWhere('l.creator', $scope['viewer']))
            ->pluck('l.book')
            ->all();

        // needsBibliographyScan is the detector's own test — asked here rather than
        // re-derived, so the estimate cannot promise a different set than the run scans.
        $detector = app(CandidateDetector::class);
        $toScan = 0;
        $references = 0;
        foreach ($books as $book) {
            if (! $detector->needsBibliographyScan($book)) {
                continue;
            }
            $toScan++;
            $references += $db->table('bibliography')->where('book', $book)->count()
                ?: $db->table('footnotes')->where('book', $book)->count();
        }

        return ['books' => count($books), 'books_to_scan' => $toScan, 'references' => $references];
    }

    /* ───────────────────────── The page ───────────────────────── */

    /**
     * GET /a/{slug}/hypercites — the workbench for the archive's shelf. 404 for everyone
     * but the shelf's owner: the page is not advertised (the archive panel shows the link
     * only when the same check passes).
     */
    public function page(Request $request, string $slug, ShelfWorkbenchAccess $access)
    {
        $archive = ArchiveSource::where('slug', $slug)->first();
        $shelf = $archive ? $access->curatableShelf((string) $archive->shelf_id, $request->user()) : null;
        if (! $shelf) {
            abort(404);
        }

        return view('maintainer-hypercites', [
            'journalSlug' => null,
            'shelfId'     => $shelf->id,
            'scopeLabel'  => $shelf->name,
            'owner'       => [
                'apiBase'    => "/api/shelf-workbench/{$shelf->id}/hypercites",
                'archiveUrl' => "/a/{$archive->slug}",
            ],
        ]);
    }

    /* ───────────────────────── API (shelf comes from the gate) ───────────────────────── */

    public function ownerCandidates(Request $request)
    {
        return $this->candidatesFor($request, $this->ownerScope($request));
    }

    public function ownerDetect(Request $request)
    {
        return $this->detectFor($request, $this->ownerScope($request));
    }

    public function ownerRunStatus(Request $request, string $shelf, string $id)
    {
        return $this->runStatus($request, $id);
    }

    public function ownerApprove(Request $request, string $shelf, string $id, HyperciteMinter $minter, ConnectionRefresher $refresher)
    {
        return $this->approve($request, $id, $minter, $refresher);
    }

    public function ownerRevert(Request $request, string $shelf, string $id, HyperciteMinter $minter, ConnectionRefresher $refresher)
    {
        return $this->revert($request, $id, $minter, $refresher);
    }

    public function ownerReject(Request $request, string $shelf, string $id, HyperciteMinter $minter)
    {
        return $this->reject($request, $id, $minter);
    }

    public function ownerOccurrence(Request $request, string $shelf, string $id)
    {
        return $this->chooseOccurrence($request, $id);
    }

    public function ownerBatchApprove(Request $request, string $shelf, HyperciteMinter $minter)
    {
        return $this->batchApproveFor($request, $this->ownerScope($request), $minter);
    }

    public function ownerMostCited(Request $request)
    {
        return $this->mostCitedFor($this->ownerScope($request));
    }

    /**
     * POST …/import-source — bring in ONE work this shelf cites, as the owner.
     *
     * Not the operator's ImportCitedSourceJob: that one has no credit check and files the
     * result on a system "Cited by:" shelf. This is the same front door as the URL importer
     * and MCP — the open-access ladder, billed to the importer, delivering the commons copy
     * (or a private personal copy when the licence does not allow public hosting) onto their
     * own "Imported works" shelf.
     */
    public function ownerImportSource(Request $request, string $shelf, ImportOrchestrator $orchestrator, SingleWorkImporter $importer)
    {
        $canonicalId = (string) $request->input('canonical_source_id', '');
        $db = DB::connection('pgsql_admin');
        $canonical = Str::isUuid($canonicalId)
            ? $db->table('canonical_source')->where('id', $canonicalId)->first()
            : null;
        if (! $canonical) {
            return response()->json(['message' => 'canonical_source_id must name an existing work.'], 422);
        }

        // Only a work this shelf actually cites: the endpoint is "import what my shelf
        // references", not a second general-purpose importer hiding behind the workbench.
        $cited = app(CitedWorksQuery::class)
            ->rows($this->ownerScope($request))
            ->firstWhere('canonical_id', $canonicalId);
        if (! $cited) {
            return response()->json(['message' => 'That work is not cited by this shelf.', 'refusal' => 'not_cited_here'], 422);
        }

        $handle = $canonical->doi
            ? 'https://doi.org/' . $canonical->doi
            : ($canonical->openalex_id ? 'https://openalex.org/' . $canonical->openalex_id : null);
        if (! $handle) {
            return response()->json(['message' => 'This work has no DOI or OpenAlex id to import by.', 'refusal' => 'not_importable'], 422);
        }

        $inspection = $orchestrator->inspect($handle);
        if (! $inspection->ok || ! SingleWorkImporter::handles($inspection->identifier)) {
            return response()->json([
                'message' => 'Could not resolve this work for import.',
                'refusal' => $inspection->error ?? 'not_importable',
            ], 422);
        }

        $user = $request->user();
        $started = $importer->start(
            $inspection->identifier,
            $inspection->metadata,
            'book_' . now()->getTimestampMs(),
            $user,
            ['creator' => $user->name, 'creator_token' => null],
            SingleWorkImporter::SURFACE_WEB,
        );

        if (! $started['ok']) {
            $error = $started['error'] ?? 'unknown_error';

            return response()->json([
                'message' => $error === 'closed_access_requires_upload'
                    ? 'No open-access copy was found — upload the file yourself to add it.'
                    : "Import refused: {$error}",
                'refusal' => $error,
            ], 422);
        }

        return response()->json([
            'status'  => $started['status'],                 // queued | running | already_available | awaiting_confirmation
            'import'  => $started['import'] ?? null,         // poll /api/import-progress/{import}
            'book'    => $started['book'] ?? null,
            'outcome' => $started['outcome'] ?? null,
        ]);
    }
}
