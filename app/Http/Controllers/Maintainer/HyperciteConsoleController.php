<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Jobs\DetectHyperciteCandidatesJob;
use App\Jobs\ImportCitedBulkJob;
use App\Jobs\ImportCitedSourceJob;
use App\Models\JournalSource;
use App\Services\Connections\ConnectionRefresher;
use App\Services\Hypercites\AutoApprovePolicy;
use App\Services\Hypercites\CitedWorksQuery;
use App\Services\Hypercites\HyperciteMinter;
use App\Services\Hypercites\MatchLocations;
use App\Services\SourceHarvest\HarvestShelf;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * /maintainer/hypercites — the citation-graph review console, sibling of
 * /maintainer/journal-import (and deliberately NOT named "citations": that word
 * is spent on the AI citation-review pipeline).
 *
 * The INDEX picks a detection SCOPE — a journal from the registry, or a PUBLIC
 * shelf (shelves are just collections of citing books, so they reuse the whole
 * pipeline; private shelves stay out because minting from them would reference
 * content the console has no business publishing). The DETAIL page reviews one
 * scope's hypercite CANDIDATES (hypercite_candidates, built by the `detect`
 * run): the citing book framed in the left reader pane, the cited book in the
 * right, a candidate list with quote/match evidence between them. Approve
 * mints the real hypercite (HyperciteMinter, synchronous — two row writes and
 * a string splice); reject is the labeled "no". The MOST-CITED tab aggregates
 * which works the scope's books cite, so the operator can import the
 * most-cited external OA sources — after which a re-detect matches against
 * them (detection matches ANY held book, not just the collection).
 *
 * Routing: journals keep the bare `/{slug}`; shelves live under `/shelf/{id}`
 * (uuid — shelf slugs are only unique PER CREATOR, so they can't name a
 * shelf globally). The shelf routes must register before the slug catch:
 * "shelf" itself matches the slug pattern.
 *
 * Web routes: admin checked in-controller, non-admins 404 (the page isn't
 * advertised — house pattern). API routes sit behind auth:sanctum + admin in
 * routes/api.php.
 *
 * Known race, accepted: a journal-import run rewriting a book's nodes while a
 * detect is reading them can only produce candidates whose content hash is
 * already stale — the minter's stale guard refuses them and a re-detect
 * re-measures. Detection never writes book content, so nothing can interleave.
 */
class HyperciteConsoleController extends Controller
{
    private const CANDIDATE_STATUSES = ['pending', 'matched', 'no_match', 'rejected', 'applied', 'failed'];

    /* ───────────────────────── Scope resolution ───────────────────────── */

    /**
     * @return ?array{type:string, column:string, id:string, label:string, meta:array}
     */
    private function journalScope(string $slug): ?array
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return null;
        }

        return [
            'type'   => 'journal',
            'column' => 'journal_source_id',
            'id'     => $journal->id,
            'label'  => (string) $journal->display_name,
            'meta'   => [
                'scope_type'   => 'journal',
                'slug'         => $journal->slug,
                'display_name' => $journal->display_name,
                'publisher'    => $journal->publisher,
            ],
        ];
    }

    private function shelfScope(string $id): ?array
    {
        if (! Str::isUuid($id)) {
            return null;
        }
        $shelf = DB::connection('pgsql_admin')->table('shelves')
            ->where('id', $id)
            ->where('visibility', 'public')
            ->first();
        if (! $shelf) {
            return null;
        }

        return [
            'type'   => 'shelf',
            'column' => 'shelf_id',
            'id'     => $shelf->id,
            'label'  => (string) $shelf->name,
            'meta'   => [
                'scope_type'   => 'shelf',
                'shelf_id'     => $shelf->id,
                'display_name' => $shelf->name,
                'publisher'    => $shelf->creator, // shown where the journal shows its publisher
            ],
        ];
    }

    /* ───────────────────────── Web pages ───────────────────────── */

    /** GET /maintainer/hypercites — pick a journal or a public shelf. */
    public function index(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        return view('maintainer-hypercites', ['journalSlug' => null, 'shelfId' => null, 'scopeLabel' => null]);
    }

    /** GET /maintainer/hypercites/{slug} — review one journal's candidates. */
    public function show(Request $request, string $slug)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }
        $scope = $this->journalScope($slug);
        if (! $scope) {
            abort(404);
        }

        return view('maintainer-hypercites', ['journalSlug' => $slug, 'shelfId' => null, 'scopeLabel' => $scope['label']]);
    }

    /** GET /maintainer/hypercites/shelf/{id} — review one public shelf's candidates. */
    public function showShelf(Request $request, string $id)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }
        $scope = $this->shelfScope($id);
        if (! $scope) {
            abort(404);
        }

        return view('maintainer-hypercites', ['journalSlug' => null, 'shelfId' => $id, 'scopeLabel' => $scope['label']]);
    }

    /* ───────────────────────── Picker payload ───────────────────────── */

    /**
     * GET /api/maintainer/hypercites/journals — the picker: the journal
     * registry (ranked as journal-import ranks it) AND the public shelves,
     * each with per-scope candidate counts by status (grouped queries, not
     * per-scope scans). Journal shelves are excluded from the shelves list —
     * they're already present as their journal.
     */
    public function journals(Request $request)
    {
        $db = DB::connection('pgsql_admin');

        $journalCounts = [];
        $shelfCounts = [];
        foreach ($db->table('hypercite_candidates')
            ->selectRaw('journal_source_id, shelf_id, status, COUNT(*) as n')
            ->groupBy('journal_source_id', 'shelf_id', 'status')->get() as $r) {
            if ($r->journal_source_id) {
                $journalCounts[$r->journal_source_id][$r->status] = (int) $r->n;
            }
            if ($r->shelf_id) {
                $shelfCounts[$r->shelf_id][$r->status] = (int) $r->n;
            }
        }

        $journals = JournalSource::query()
            ->orderByRaw('cited_by_count DESC NULLS LAST')
            ->get()
            ->map(fn (JournalSource $j) => [
                'slug'              => $j->slug,
                'display_name'      => $j->display_name,
                'publisher'         => $j->publisher,
                'works_count'       => $j->works_count,
                'last_harvested_at' => $j->last_harvested_at?->toIso8601String(),
                'candidates'        => $journalCounts[$j->id] ?? new \stdClass(),
            ])
            ->values();

        $journalShelfIds = JournalSource::query()->whereNotNull('shelf_id')->pluck('shelf_id')->all();

        $shelves = $db->table('shelves as s')
            ->leftJoin('shelf_items as si', 'si.shelf_id', '=', 's.id')
            ->where('s.visibility', 'public')
            ->when($journalShelfIds !== [], fn ($q) => $q->whereNotIn('s.id', $journalShelfIds))
            ->groupBy('s.id', 's.name', 's.creator')
            ->orderByRaw('COUNT(si.book) DESC')
            ->get(['s.id', 's.name', 's.creator', DB::connection('pgsql_admin')->raw('COUNT(si.book) as item_count')])
            ->map(fn ($s) => [
                'shelf_id'   => $s->id,
                'name'       => $s->name,
                'creator'    => $s->creator,
                'item_count' => (int) $s->item_count,
                'candidates' => $shelfCounts[$s->id] ?? new \stdClass(),
            ])
            ->values();

        return response()->json(['journals' => $journals, 'shelves' => $shelves]);
    }

    /* ───────────────────────── Candidates ───────────────────────── */

    public function candidates(Request $request, string $slug)
    {
        $scope = $this->journalScope($slug);

        return $scope ? $this->candidatesFor($request, $scope) : response()->json(['message' => 'Journal not found'], 404);
    }

    public function shelfCandidates(Request $request, string $id)
    {
        $scope = $this->shelfScope($id);

        return $scope ? $this->candidatesFor($request, $scope) : response()->json(['message' => 'Shelf not found (or not public)'], 404);
    }

    /**
     * One scope's candidates, flat (the page groups by citing book), with both
     * sides' titles resolved. Filters are query params; all optional. Shelf
     * books may be canonical-less, so citing titles fall back to library.title.
     */
    private function candidatesFor(Request $request, array $scope)
    {
        $db = DB::connection('pgsql_admin');

        $q = $db->table('hypercite_candidates as hc')
            ->leftJoin('canonical_source as citing', 'citing.id', '=', 'hc.citing_canonical_source_id')
            ->leftJoin('canonical_source as cited', 'cited.id', '=', 'hc.cited_canonical_source_id')
            ->leftJoin('library as citing_lib', 'citing_lib.book', '=', 'hc.citing_book')
            ->leftJoin('library as cited_lib', 'cited_lib.book', '=', 'hc.cited_book')
            ->where("hc.{$scope['column']}", $scope['id']);

        if ($request->filled('status') && in_array($request->query('status'), self::CANDIDATE_STATUSES, true)) {
            $q->where('hc.status', $request->query('status'));
        }
        // Ownership, not status. The console's permanent "applied hypercites"
        // list asks for `minted` rather than status=applied because a
        // re-detect parks an applied row at `pending` while its ↗ is still on
        // the page — and a live hypercite silently dropping out of that list is
        // exactly how a duplicate mint went unnoticed.
        if ($request->has('minted')) {
            $request->boolean('minted')
                ? $q->whereNotNull('hc.hypercite_id')
                : $q->whereNull('hc.hypercite_id');
        }
        if ($request->has('has_quote')) {
            $q->where('hc.has_quote', $request->boolean('has_quote'));
        }
        if ($request->has('internal')) {
            $q->where('hc.is_internal', $request->boolean('internal'));
        }
        if ($request->filled('match_method')) {
            $q->where('hc.match_method', $request->query('match_method'));
        }
        if ($request->filled('min_score')) {
            $q->where('hc.match_score', '>=', (float) $request->query('min_score'));
        }
        if ($request->filled('citing')) {
            $q->where('hc.citing_canonical_source_id', $request->query('citing'));
        }

        $rows = $q->orderByRaw('citing.cited_by_count DESC NULLS LAST')
            ->orderBy('hc.citing_book')
            ->orderBy('hc.citing_node_id')
            ->orderBy('hc.occurrence_index')
            ->select([
                'hc.id', 'hc.status', 'hc.error', 'hc.is_internal',
                'hc.citing_canonical_source_id', 'hc.cited_canonical_source_id',
                'hc.citing_book', 'hc.cited_book', 'hc.reference_id', 'hc.occurrence_index',
                'hc.citing_node_id', 'hc.marker_offset', 'hc.claim_start', 'hc.claim_end',
                'hc.has_quote', 'hc.quote_kind', 'hc.quote_text', 'hc.quote_node_id',
                'hc.match_node_ids', 'hc.match_char_data', 'hc.match_method', 'hc.match_score', 'hc.match_occurrences',
                'hc.match_locations', 'hc.match_location_index',
                'hc.hypercite_id', 'hc.auto_approved', 'hc.reviewed_at', 'hc.applied_at',
                DB::connection('pgsql_admin')->raw('COALESCE(citing.title, citing_lib.title) as citing_title'),
                'citing.author as citing_author', 'citing.year as citing_year',
                DB::connection('pgsql_admin')->raw('COALESCE(cited.title, cited_lib.title) as cited_title'),
                'cited.author as cited_author', 'cited.year as cited_year',
            ])
            ->limit(2000)
            ->get()
            ->map(function ($r) {
                $r->match_node_ids = json_decode((string) $r->match_node_ids, true);
                $r->match_char_data = json_decode((string) $r->match_char_data, true);
                // The occurrence picker needs every location's spans to re-mark
                // the cited pane; attachStartLines() adds where each one sits.
                $r->match_locations = MatchLocations::decode($r->match_locations);
                $r->match_location_index = (int) ($r->match_location_index ?? 0);
                $r->quote_text = $r->quote_text !== null ? Str::limit($r->quote_text, 600) : null;

                return $r;
            });

        // The reader's URL-hash navigation resolves NUMERIC targets as a node's
        // startLine (the DOM id — see SPA/navigation/resolveTargetChunk.ts);
        // a data-node-id resolves to NOTHING and the pane opens at the top.
        // So each candidate carries the live startLine of its citing node and
        // of the first matched cited node, looked up at read time — startLines
        // are positional and shift on reconvert, so they are never stored.
        $this->attachStartLines($rows);
        // Applied rows also carry the citing-side anchor id (the ↗'s element
        // id, parsed from the hypercite row's citedIN) so the citing pane can
        // deep-link to the exact arrow rather than just the paragraph.
        $this->attachAnchorIds($rows);

        $statusCounts = [];
        foreach ($db->table('hypercite_candidates')
            ->where($scope['column'], $scope['id'])
            ->selectRaw('status, COUNT(*) as n')->groupBy('status')->get() as $r) {
            $statusCounts[$r->status] = (int) $r->n;
        }

        // An in-flight detect rides along so a REFRESHED page re-attaches its
        // poll instead of sitting silent until the operator presses detect
        // again (harmless — the collision guard joins the same run — but it
        // reads as "it stopped").
        $activeRun = $db->table('hypercite_runs')
            ->where($scope['column'], $scope['id'])
            ->where('action', 'detect')
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->orderByDesc('created_at')
            ->first(['id', 'status', 'step_detail']);

        return response()->json([
            'scope'         => $scope['meta'],
            'status_counts' => $statusCounts,
            'active_run'    => $activeRun,
            'candidates'    => $rows,
        ]);
    }

    /**
     * Attach citing_start_line / cited_start_line to candidate rows in one
     * batched (book, node_id) → startLine lookup.
     *
     * Every LOCATION gets a start line, not just the selected one
     * (`location_start_lines`, index-aligned with `match_locations`): the
     * occurrence picker has to scroll the cited pane to a location the reviewer
     * has not chosen yet, and the pane scrolls by startLine. They stay in the
     * same batched query — one more (book, node_id) pair per occurrence.
     *
     * @param \Illuminate\Support\Collection<int, object> $rows
     */
    private function attachStartLines($rows): void
    {
        $pairs = [];
        foreach ($rows as $r) {
            $pairs["{$r->citing_book}\x00{$r->citing_node_id}"] = [$r->citing_book, $r->citing_node_id];
            foreach ($this->locationNodeIds($r) as $nodeId) {
                $pairs["{$r->cited_book}\x00{$nodeId}"] = [$r->cited_book, $nodeId];
            }
        }
        if ($pairs === []) {
            return;
        }

        $db = DB::connection('pgsql_admin');
        $startLines = [];
        foreach (array_chunk(array_values($pairs), 500) as $chunk) {
            $placeholders = implode(',', array_fill(0, count($chunk), '(?,?)'));
            $bindings = array_merge(...$chunk);
            foreach ($db->select(
                "SELECT book, node_id, \"startLine\" FROM nodes WHERE (book, node_id) IN ({$placeholders})",
                $bindings
            ) as $n) {
                $startLines["{$n->book}\x00{$n->node_id}"] = $n->startLine;
            }
        }

        foreach ($rows as $r) {
            $r->citing_start_line = $startLines["{$r->citing_book}\x00{$r->citing_node_id}"] ?? null;
            $firstCited = is_array($r->match_node_ids) ? ($r->match_node_ids[0] ?? null) : null;
            $r->cited_start_line = $firstCited
                ? ($startLines["{$r->cited_book}\x00{$firstCited}"] ?? null)
                : null;
            $r->location_start_lines = array_map(
                fn ($nodeId) => $startLines["{$r->cited_book}\x00{$nodeId}"] ?? null,
                $this->locationNodeIds($r),
            );
        }
    }

    /**
     * The first cited node id of each of a candidate's match locations, in
     * `match_locations` order. Falls back to the mirrored `match_node_ids` for
     * rows detected before locations were stored, so an old candidate still
     * resolves its one start line.
     *
     * @return list<string>
     */
    private function locationNodeIds(object $r): array
    {
        $locations = MatchLocations::decode($r->match_locations ?? null);
        if ($locations === []) {
            $first = is_array($r->match_node_ids) ? ($r->match_node_ids[0] ?? null) : null;

            return $first ? [$first] : [];
        }

        $out = [];
        foreach ($locations as $location) {
            $nodeId = $location['node_ids'][0] ?? null;
            if ($nodeId) {
                $out[] = $nodeId;
            }
        }

        return $out;
    }

    /**
     * For candidates that own a minted hypercite: the ↗ anchor's element id in
     * the citing book, parsed from the hypercites row's citedIN entry — the
     * reader's hash resolver finds it by content scan, landing the pane on the
     * arrow itself. Keyed on hypercite_id rather than status === 'applied',
     * because a re-detect parks an applied row at `pending` while its ↗ is
     * still very much on the page — and that is precisely the row a reviewer
     * needs to look at.
     *
     * @param \Illuminate\Support\Collection<int, object> $rows
     */
    private function attachAnchorIds($rows): void
    {
        $applied = $rows->filter(fn ($r) => (bool) $r->hypercite_id);
        foreach ($rows as $r) {
            $r->anchor_id = null;
        }
        if ($applied->isEmpty()) {
            return;
        }

        $db = DB::connection('pgsql_admin');
        $hypercites = $db->table('hypercites')
            ->whereIn('hyperciteId', $applied->pluck('hypercite_id')->all())
            ->get(['book', 'hyperciteId', 'citedIN']);

        $byKey = [];
        foreach ($hypercites as $h) {
            $byKey["{$h->book}\x00{$h->hyperciteId}"] = json_decode((string) $h->citedIN, true) ?: [];
        }

        foreach ($applied as $r) {
            foreach ($byKey["{$r->cited_book}\x00{$r->hypercite_id}"] ?? [] as $entry) {
                if (str_starts_with((string) $entry, "/{$r->citing_book}#")) {
                    $r->anchor_id = substr((string) $entry, strlen("/{$r->citing_book}#"));
                    break;
                }
            }
        }
    }

    /* ───────────────────────── Detect + poll ───────────────────────── */

    public function detect(Request $request, string $slug)
    {
        $scope = $this->journalScope($slug);

        return $scope ? $this->detectFor($request, $scope) : response()->json(['message' => 'Journal not found.'], 404);
    }

    public function shelfDetect(Request $request, string $id)
    {
        $scope = $this->shelfScope($id);

        return $scope ? $this->detectFor($request, $scope) : response()->json(['message' => 'Shelf not found (or not public).'], 404);
    }

    /**
     * Queue a detection run. Same collision + polling contract as
     * journal-import's run(): one detect per scope at a time; a dead worker is
     * failed by the 30-minute watchdog in runStatus rather than blocking forever.
     */
    private function detectFor(Request $request, array $scope)
    {
        $db = DB::connection('pgsql_admin');

        $inFlight = $db->table('hypercite_runs')
            ->where($scope['column'], $scope['id'])
            ->where('action', 'detect')
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->first();
        if ($inFlight) {
            return response()->json([
                'run_id'          => $inFlight->id,
                'already_running' => true,
                'action'          => $inFlight->action,
            ]);
        }

        $runId = (string) Str::uuid();
        $db->table('hypercite_runs')->insert([
            'id'             => $runId,
            $scope['column'] => $scope['id'],
            'user_id'        => $request->user()?->id,
            'action'         => 'detect',
            'status'         => 'pending',
            'counts'         => '{}',
            'created_at'     => now(),
            'updated_at'     => now(),
        ]);

        DetectHyperciteCandidatesJob::dispatch($runId, $request->boolean('auto_approve'));

        return response()->json(['run_id' => $runId, 'already_running' => false]);
    }

    /** GET /api/maintainer/hypercites/runs/{id} — poll a run (30-min stale watchdog). */
    public function runStatus(Request $request, string $id)
    {
        $db = DB::connection('pgsql_admin');
        $run = $db->table('hypercite_runs')->where('id', $id)->first();
        if (! $run) {
            return response()->json(['message' => 'Run not found.'], 404);
        }

        if (in_array($run->status, ['pending', 'running'], true)
            && strtotime((string) $run->updated_at) < strtotime('-30 minutes')) {
            $error = 'no progress for 30 minutes — the worker died or was never running';
            $db->table('hypercite_runs')->where('id', $id)->update([
                'status'     => 'failed',
                'error'      => $error,
                'updated_at' => now(),
            ]);
            $run->status = 'failed';
            $run->error = $error;
        }

        return response()->json([
            'id'          => $run->id,
            'status'      => $run->status,
            'action'      => $run->action,
            'step_detail' => $run->step_detail,
            'counts'      => json_decode((string) $run->counts, true) ?: [],
            'error'       => $run->error,
        ]);
    }

    /* ───────────────────────── Verdicts ───────────────────────── */

    /**
     * POST /api/maintainer/hypercites/candidates/{id}/occurrence — choose WHICH
     * match in the cited work this hypercite should land on.
     *
     * A quote can appear in its source many times, and the reviewer is the only
     * one who can say which occurrence the citing author meant. Detection ranks
     * the list and mirrors the top entry; this moves the mirror to the entry the
     * reviewer stepped to, so approve() mints against what the pane is showing.
     * Nothing else changes — the mirror IS the interface every downstream reader
     * already uses (MatchLocations).
     *
     * Refuses while the candidate owns a live hypercite: the minted row's
     * charData was copied from the mirror at mint time, so moving the mirror
     * underneath it would leave the hypercite pointing at text nobody chose and
     * the console describing a location that is not the one on the page. Revert
     * first — the same ownership rule mint() and unmint() enforce.
     */
    public function chooseOccurrence(Request $request, string $id)
    {
        $index = $request->integer('index');
        $db = DB::connection('pgsql_admin');

        $candidate = $db->table('hypercite_candidates')
            ->where('id', $id)
            ->first(['id', 'hypercite_id', 'match_locations']);

        if (! $candidate) {
            return response()->json(['message' => 'Candidate not found.'], 404);
        }
        if ($candidate->hypercite_id) {
            return response()->json([
                'message' => 'This candidate already owns a hypercite — revert it before moving the target.',
                'refusal' => 'already_minted',
            ], 409);
        }

        $locations = MatchLocations::decode($candidate->match_locations);
        if (! isset($locations[$index])) {
            return response()->json([
                'message' => 'No such occurrence for this candidate.',
                'refusal' => 'no_such_occurrence',
            ], 422);
        }

        $mirror = MatchLocations::mirror($locations, $index);
        $db->table('hypercite_candidates')->where('id', $id)
            ->update($mirror + ['updated_at' => now()]);

        return response()->json([
            'chosen'          => $index,
            'match_node_ids'  => $locations[$index]['node_ids'] ?? [],
            'match_char_data' => $locations[$index]['char_data'] ?? [],
            'match_method'    => $mirror['match_method'],
            'match_score'     => $mirror['match_score'],
        ]);
    }

    /**
     * POST /api/maintainer/hypercites/candidates/{id}/approve — mint. Sync:
     * two row writes and a string splice. 409 carries the stale-guard refusal
     * so the page can say "re-detect first" instead of a generic failure —
     * and `already_minted`, which means the opposite: revert first, this
     * candidate still owns a live hypercite.
     */
    public function approve(Request $request, string $id, HyperciteMinter $minter, ConnectionRefresher $refresher)
    {
        $result = $minter->mint($id, $request->user()?->id);

        if ($result['applied'] ?? false) {
            // A new edge changes both books' connection scores AND invalidates
            // every cached feed that ranks on them — without this the journal
            // page keeps serving the pre-mint order forever.
            $refresher->refresh([$result['citingBook'] ?? null, $result['citedBook'] ?? null]);
        }

        if (! ($result['applied'] ?? false)) {
            $refusal = $result['refusal'] ?? 'unknown';
            $status = match (true) {
                $refusal === 'not_found'            => 404,
                $refusal === 'already_minted'       => 409,
                str_starts_with($refusal, 'stale_') => 409,
                default                             => 422,
            };

            return response()->json([
                'message' => "Cannot apply this candidate: {$refusal}",
                'refusal' => $refusal,
            ], $status);
        }

        return response()->json($result);
    }

    /**
     * POST /api/maintainer/hypercites/candidates/{id}/revert — undo an apply:
     * anchor unspliced, hypercites row deleted, candidate back to `matched`
     * for re-review. 409 when the citing node drifted since the apply.
     */
    public function revert(Request $request, string $id, HyperciteMinter $minter, ConnectionRefresher $refresher)
    {
        $result = $minter->unmint($id, $request->user()?->id);

        if ($result['reverted'] ?? false) {
            $refresher->refresh([$result['citingBook'] ?? null, $result['citedBook'] ?? null]);
        }

        if (! ($result['reverted'] ?? false)) {
            $refusal = $result['refusal'] ?? 'unknown';
            $status = match (true) {
                $refusal === 'not_found'            => 404,
                str_starts_with($refusal, 'stale_') => 409,
                default                             => 422,
            };

            return response()->json([
                'message' => "Cannot revert this candidate: {$refusal}",
                'refusal' => $refusal,
            ], $status);
        }

        return response()->json(['reverted' => true]);
    }

    /** POST /api/maintainer/hypercites/candidates/{id}/reject */
    public function reject(Request $request, string $id, HyperciteMinter $minter)
    {
        if (! $minter->reject($id, $request->user()?->id)) {
            return response()->json(['message' => 'Candidate not found or not rejectable.'], 422);
        }

        return response()->json(['rejected' => true]);
    }

    public function batchApprove(Request $request, string $slug, HyperciteMinter $minter)
    {
        $scope = $this->journalScope($slug);

        return $scope ? $this->batchApproveFor($request, $scope, $minter) : response()->json(['message' => 'Journal not found.'], 404);
    }

    public function shelfBatchApprove(Request $request, string $id, HyperciteMinter $minter)
    {
        $scope = $this->shelfScope($id);

        return $scope ? $this->batchApproveFor($request, $scope, $minter) : response()->json(['message' => 'Shelf not found (or not public).'], 404);
    }

    /**
     * Approve a filtered set in one press. The server re-checks
     * AutoApprovePolicy per row (the client's filter is a convenience, not the
     * gate) and stays synchronous, hence the cap: past it, narrow the filter.
     */
    private function batchApproveFor(Request $request, array $scope, HyperciteMinter $minter)
    {
        $ids = array_values(array_filter((array) $request->input('ids', []), 'is_string'));
        $max = (int) config('hypercites.batch_approve_max', 25);
        if ($ids === []) {
            return response()->json(['message' => 'ids is required.'], 422);
        }
        if (count($ids) > $max) {
            return response()->json([
                'message' => "Batch approve is capped at {$max} — narrow the filter.",
                'refusal' => 'too_many',
            ], 422);
        }

        $db = DB::connection('pgsql_admin');
        $userId = $request->user()?->id;
        $results = ['applied' => 0, 'skipped_policy' => 0, 'failed' => 0];
        $touched = [];

        foreach ($db->table('hypercite_candidates')
            ->whereIn('id', $ids)
            ->where($scope['column'], $scope['id'])
            ->get() as $candidate) {
            if (! AutoApprovePolicy::qualifies($candidate)) {
                $results['skipped_policy']++;
                continue;
            }
            $r = $minter->mint($candidate->id, $userId);
            $results[($r['applied'] ?? false) ? 'applied' : 'failed']++;
            if ($r['applied'] ?? false) {
                $touched[] = $r['citingBook'] ?? null;
                $touched[] = $r['citedBook'] ?? null;
            }
        }

        // ONE refresh for the whole batch: per-mint would recompute and flush
        // the same shelves up to `batch_approve_max` times over.
        app(ConnectionRefresher::class)->refresh($touched);

        return response()->json($results);
    }

    /* ───────────────────────── Most cited + import ───────────────────────── */

    public function mostCited(Request $request, string $slug)
    {
        $scope = $this->journalScope($slug);

        return $scope ? $this->mostCitedFor($scope) : response()->json(['message' => 'Journal not found.'], 404);
    }

    public function shelfMostCited(Request $request, string $id)
    {
        $scope = $this->shelfScope($id);

        return $scope ? $this->mostCitedFor($scope) : response()->json(['message' => 'Shelf not found (or not public).'], 404);
    }

    /**
     * Which works this scope's books cite, most-cited first, split internal
     * (also in the collection) vs external, with the flags that make an
     * external row actionable: held / OA / fetchable / importable. The query
     * lives in CitedWorksQuery so the bulk import job's work-list is exactly
     * what this tab shows.
     *
     * `cited_shelf` is the scope's "Cited by:" collection shelf when one
     * exists (created by the first import), so the page can link straight to
     * /maintainer/shelf-import for assessment.
     */
    private function mostCitedFor(array $scope)
    {
        $rows = app(CitedWorksQuery::class)->rows($scope);

        $citedShelf = DB::connection('pgsql_admin')->table('shelves')
            ->where('creator', \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR)
            ->where('name', HarvestShelf::CITED_NAME_PREFIX . Str::limit($scope['label'], 230, '…'))
            ->first(['id', 'name']);

        return response()->json([
            'internal'    => $rows->filter(fn ($r) => $r['is_internal'])->values(),
            'external'    => $rows->filter(fn ($r) => ! $r['is_internal'])->values(),
            'cited_shelf' => $citedShelf ? ['id' => $citedShelf->id, 'name' => $citedShelf->name] : null,
        ]);
    }

    public function importSource(Request $request, string $slug)
    {
        $scope = $this->journalScope($slug);

        return $scope ? $this->importSourceFor($request, $scope) : response()->json(['message' => 'Journal not found.'], 404);
    }

    public function shelfImportSource(Request $request, string $id)
    {
        $scope = $this->shelfScope($id);

        return $scope ? $this->importSourceFor($request, $scope) : response()->json(['message' => 'Shelf not found (or not public).'], 404);
    }

    /**
     * Fetch one external cited work so a re-detect can match against it.
     * Queued (it hits a publisher and may run OCR); billed to the presser.
     */
    private function importSourceFor(Request $request, array $scope)
    {
        $canonicalId = (string) $request->input('canonical_source_id', '');
        $db = DB::connection('pgsql_admin');
        // Shape-check before querying: the column is uuid-typed, so a malformed
        // id would throw at the cast instead of 422ing.
        $canonical = Str::isUuid($canonicalId)
            ? $db->table('canonical_source')->where('id', $canonicalId)->first()
            : null;
        if (! $canonical) {
            return response()->json(['message' => 'canonical_source_id must name an existing work.'], 422);
        }
        if (! $canonical->is_oa || ! ($canonical->pdf_url || $canonical->oa_url || $canonical->doi)) {
            return response()->json([
                'message' => 'This work is not importable (not OA, or nothing fetchable).',
                'refusal' => 'not_importable',
            ], 422);
        }

        // Guard both the per-work rerun AND a scope-wide bulk that may be
        // about to attempt this same canonical — two workers writing one
        // work's version rows is the thing being prevented.
        $inFlight = $db->table('hypercite_runs')
            ->where(function ($q) use ($canonicalId, $scope) {
                $q->where(fn ($w) => $w->where('canonical_source_id', $canonicalId)->where('action', 'import_source'))
                    ->orWhere(fn ($w) => $w->where($scope['column'], $scope['id'])->where('action', 'import_cited_bulk'));
            })
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->first();
        if ($inFlight) {
            return response()->json(['run_id' => $inFlight->id, 'already_running' => true, 'action' => $inFlight->action]);
        }

        $runId = (string) Str::uuid();
        $db->table('hypercite_runs')->insert([
            'id'                  => $runId,
            $scope['column']      => $scope['id'],
            'canonical_source_id' => $canonicalId,
            'user_id'             => $request->user()?->id,
            'action'              => 'import_source',
            'status'              => 'pending',
            'counts'              => '{}',
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);

        ImportCitedSourceJob::dispatch($runId);

        return response()->json(['run_id' => $runId, 'already_running' => false]);
    }

    public function importCitedBulk(Request $request, string $slug)
    {
        $scope = $this->journalScope($slug);

        return $scope ? $this->importCitedBulkFor($request, $scope) : response()->json(['message' => 'Journal not found.'], 404);
    }

    public function shelfImportCitedBulk(Request $request, string $id)
    {
        $scope = $this->shelfScope($id);

        return $scope ? $this->importCitedBulkFor($request, $scope) : response()->json(['message' => 'Shelf not found (or not public).'], 404);
    }

    /** The bulk cap options — same ladder as journal-import's import_all (0 = all listed). */
    private const BULK_WORK_LIMITS = [5, 25, 100, 0];

    /**
     * Import the scope's importable external works in one press, collecting
     * the results onto the scope's "Cited by:" shelf for assessment in
     * /maintainer/shelf-import. Queued and capped: every work may hit a
     * publisher and run OCR, billed to the presser.
     */
    private function importCitedBulkFor(Request $request, array $scope)
    {
        $limit = (int) $request->input('limit', 5);
        if (! in_array($limit, self::BULK_WORK_LIMITS, true)) {
            return response()->json([
                'message' => 'limit must be one of ' . implode(', ', self::BULK_WORK_LIMITS) . ' (0 = all listed).',
            ], 422);
        }

        $db = DB::connection('pgsql_admin');

        // One acquisition run per scope at a time, in either direction: a bulk
        // joins a running bulk, and never starts over an in-flight single
        // import (whose canonical it may be about to re-attempt).
        $inFlight = $db->table('hypercite_runs')
            ->where($scope['column'], $scope['id'])
            ->whereIn('action', ['import_cited_bulk', 'import_source'])
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->first();
        if ($inFlight) {
            return response()->json([
                'run_id'          => $inFlight->id,
                'already_running' => true,
                'action'          => $inFlight->action,
            ]);
        }

        $runId = (string) Str::uuid();
        $db->table('hypercite_runs')->insert([
            'id'             => $runId,
            $scope['column'] => $scope['id'],
            'user_id'        => $request->user()?->id,
            'action'         => 'import_cited_bulk',
            'status'         => 'pending',
            'work_limit'     => $limit,
            'counts'         => '{}',
            'created_at'     => now(),
            'updated_at'     => now(),
        ]);

        ImportCitedBulkJob::dispatch($runId);

        return response()->json(['run_id' => $runId, 'already_running' => false]);
    }
}
