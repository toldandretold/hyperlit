<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Jobs\DetectHyperciteCandidatesJob;
use App\Jobs\ImportCitedSourceJob;
use App\Models\JournalSource;
use App\Services\CanonicalVersions\BestVersionService;
use App\Services\Hypercites\AutoApprovePolicy;
use App\Services\Hypercites\HyperciteMinter;
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
     * @param \Illuminate\Support\Collection<int, object> $rows
     */
    private function attachStartLines($rows): void
    {
        $pairs = [];
        foreach ($rows as $r) {
            $pairs["{$r->citing_book}\x00{$r->citing_node_id}"] = [$r->citing_book, $r->citing_node_id];
            $firstCited = is_array($r->match_node_ids) ? ($r->match_node_ids[0] ?? null) : null;
            if ($firstCited) {
                $pairs["{$r->cited_book}\x00{$firstCited}"] = [$r->cited_book, $firstCited];
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
     * POST /api/maintainer/hypercites/candidates/{id}/approve — mint. Sync:
     * two row writes and a string splice. 409 carries the stale-guard refusal
     * so the page can say "re-detect first" instead of a generic failure.
     */
    public function approve(Request $request, string $id, HyperciteMinter $minter)
    {
        $result = $minter->mint($id, $request->user()?->id);

        if (! ($result['applied'] ?? false)) {
            $refusal = $result['refusal'] ?? 'unknown';
            $status = match (true) {
                $refusal === 'not_found'            => 404,
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
    public function revert(Request $request, string $id, HyperciteMinter $minter)
    {
        $result = $minter->unmint($id, $request->user()?->id);

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
        }

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
     * external row actionable: held / OA / fetchable / importable.
     *
     * The union mirrors HarvestEligibility::reachedCanonicalIdsSubquery's
     * three branches, rooted on every held book of the scope at once and
     * keeping the citing book for the COUNT(DISTINCT). Counts undercount until
     * citation:scan-bibliography has run per book — the detect run does that,
     * so the page nudges "run detection first".
     */
    private function mostCitedFor(array $scope)
    {
        if ($scope['type'] === 'journal') {
            $best = BestVersionService::sqlCoalesceExpression('a');
            $articlesCte = <<<SQL
                SELECT l.book
                FROM canonical_source a
                JOIN library l ON l.book = ({$best})
                WHERE a.journal_source_id = :scope
                  AND l.has_nodes = true
            SQL;
            $internalExpr = '(cs.journal_source_id = :scope2)';
        } else {
            $articlesCte = <<<SQL
                SELECT l.book
                FROM shelf_items si
                JOIN library l ON l.book = si.book
                WHERE si.shelf_id = :scope
                  AND l.has_nodes = true
            SQL;
            $internalExpr = <<<SQL
                EXISTS (
                    SELECT 1 FROM shelf_items si2
                    JOIN library lb ON lb.book = si2.book
                    WHERE si2.shelf_id = :scope2 AND lb.canonical_source_id = cs.id
                )
            SQL;
        }

        $sql = <<<SQL
            WITH articles AS (
                {$articlesCte}
            ),
            cited AS (
                SELECT b.book AS citing_book, b.canonical_source_id AS cited_id
                FROM bibliography b JOIN articles ar ON ar.book = b.book
                WHERE b.canonical_source_id IS NOT NULL
                UNION
                SELECT b.book, l.canonical_source_id
                FROM bibliography b
                JOIN library l ON l.book = b.foundation_source
                JOIN articles ar ON ar.book = b.book
                WHERE l.canonical_source_id IS NOT NULL
                UNION
                SELECT f.book, l.canonical_source_id
                FROM footnotes f
                JOIN library l ON l.book = f.foundation_source
                JOIN articles ar ON ar.book = f.book
                WHERE f.is_citation = true AND l.canonical_source_id IS NOT NULL
            )
            SELECT
                cs.id, cs.title, cs.author, cs.year, cs.journal, cs.doi,
                cs.is_oa, cs.oa_status, cs.pdf_url, cs.oa_url, cs.cited_by_count,
                {$internalExpr} AS is_internal,
                COUNT(DISTINCT c.citing_book) AS citing_count,
                EXISTS (
                    SELECT 1 FROM library lv
                    WHERE lv.canonical_source_id = cs.id
                      AND lv.has_nodes = true AND lv.visibility = 'public'
                ) AS held
            FROM cited c
            JOIN canonical_source cs ON cs.id = c.cited_id
            GROUP BY cs.id
            ORDER BY citing_count DESC, cs.cited_by_count DESC NULLS LAST
            LIMIT 150
        SQL;

        $rows = collect(DB::connection('pgsql_admin')->select($sql, [
            'scope'  => $scope['id'],
            'scope2' => $scope['id'],
        ]))->map(function ($r) {
            $fetchable = (bool) ($r->pdf_url || $r->oa_url || $r->doi);

            return [
                'canonical_id'   => $r->id,
                'title'          => $r->title,
                'author'         => $r->author,
                'year'           => $r->year,
                'journal'        => $r->journal,
                'doi'            => $r->doi,
                'citing_count'   => (int) $r->citing_count,
                'cited_by_count' => $r->cited_by_count,   // OpenAlex world count, context only
                'is_internal'    => (bool) $r->is_internal,
                'held'           => (bool) $r->held,
                'is_oa'          => (bool) $r->is_oa,
                'fetchable'      => $fetchable,
                'importable'     => (bool) ($r->is_oa && $fetchable && ! $r->held),
            ];
        });

        return response()->json([
            'internal' => $rows->filter(fn ($r) => $r['is_internal'])->values(),
            'external' => $rows->filter(fn ($r) => ! $r['is_internal'])->values(),
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

        $inFlight = $db->table('hypercite_runs')
            ->where('canonical_source_id', $canonicalId)
            ->where('action', 'import_source')
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->first();
        if ($inFlight) {
            return response()->json(['run_id' => $inFlight->id, 'already_running' => true, 'action' => 'import_source']);
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
}
