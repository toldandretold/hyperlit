<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Jobs\JournalImportActionJob;
use App\Models\JournalSource;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Conversion\ReconvertQueue;
use App\Services\JournalHarvest\HtmlLaneCreator;
use App\Services\JournalHarvest\JournalVersionPromoter;
use App\Services\SourceHarvest\HarvestEligibility;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * /maintainer/journal-import — the journal pipeline's operator console, sibling of
 * /maintainer/conversion and /maintainer/jobs.
 *
 * Two levels. The INDEX picks a journal: what's already being imported (and how far), and the
 * ranked worklist of what to do next — both straight off the existing `journal_sources` registry
 * (`journal:list` and /j render the same query), so there is no second source of truth. The
 * DETAIL page works one journal: every article it knows about, and for each article every
 * imported LANE.
 *
 * Why lanes are the unit: a canonical can carry sibling `library` rows — one per
 * `foundation_source` — and the PDF and HTML lanes of the same article convert very differently
 * (GSCJ: OCR silently dropped 'References' and 'Conflict of interest'; the HTML lane keeps them).
 * Comparing those two IS the debugging workflow, so the per-article query joins on
 * `canonical_source_id`, NOT on the `auto_version_book` pointer — the pointer join used by
 * JournalPageController::show and HarvestShelf can only ever show the promoted one.
 *
 * Web route: admin checked in-controller, non-admins get 404 (the page isn't advertised —
 * mirrors MaintainerController/JobsController). API routes sit behind the auth:sanctum + admin
 * middleware group in routes/api.php.
 */
class JournalImportController extends Controller
{
    /** Everything the console can fire; see JournalImportActionJob for what each one means. */
    private const ACTIONS = ['import', 'reconvert_html', 'refetch_html', 'enumerate', 'import_all'];

    /**
     * The actions that act on the JOURNAL rather than one article. They take no `canonical_id`
     * and no `book`, and they cannot safely overlap anything else on the same journal — an
     * `import_all` and a per-article `import` racing on the same work would interleave node
     * writes on one book.
     */
    private const JOURNAL_ACTIONS = ['enumerate', 'import_all'];

    /** Caps offered for a bulk import. 0 = every eligible work — deliberate, never the default. */
    private const WORK_LIMITS = [5, 25, 100, 0];

    /** Lane identity: which foundation_source minted a row, and what to call it in the UI. */
    private const LANE_LABELS = [
        'canonical_pdf_vacuum' => 'pdf',
        'journal_html'         => 'html',
        'ar5iv_latexml'        => 'ar5iv',
    ];

    /** GET /maintainer/journal-import — pick a journal. */
    public function index(Request $request)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        return view('maintainer-journal-import');
    }

    /** GET /maintainer/journal-import/{slug} — work one journal. */
    public function show(Request $request, string $slug)
    {
        $user = $request->user();
        if (! $user || ! $user->isAdmin()) {
            abort(404);
        }

        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            abort(404);
        }

        return view('maintainer-journal-import-detail', ['journalSlug' => $journal->slug]);
    }

    /**
     * GET /api/maintainer/journal-import/journals — the index payload.
     *
     * One pass over the registry, split into what's underway and what's next. Article counts come
     * from a single grouped query rather than per-journal estimates: estimateForJournal
     * materialises the whole eligible collection per call, which is fine for one journal's page
     * but not for a list of them.
     */
    public function journals(Request $request)
    {
        $journals = JournalSource::query()
            ->orderByRaw('cited_by_count DESC NULLS LAST')
            ->get();

        $counts = $this->articleCountsByJournal();

        $rows = $journals->map(function (JournalSource $j) use ($counts) {
            $c = $counts[$j->id] ?? ['total' => 0, 'imported' => 0, 'eligible' => 0];
            $stats = $j->harvest_stats ?? [];

            return [
                'slug'                => $j->slug,
                'display_name'        => $j->display_name,
                'publisher'           => $j->publisher,
                'issn_l'              => $j->issn_l,
                'openalex_source_id'  => $j->openalex_source_id,
                'is_diamond'          => (bool) $j->is_diamond,
                'diamond_provenance'  => $j->diamond_provenance,
                'works_count'         => $j->works_count,
                'cited_by_count'      => $j->cited_by_count,
                'last_harvested_at'   => $j->last_harvested_at?->toIso8601String(),
                'harvest_runs'        => $stats['runs'] ?? 0,
                'harvest_spend'       => $stats['spend'] ?? 0,
                'articles_total'      => $c['total'],
                'articles_imported'   => $c['imported'],
                'articles_eligible'   => $c['eligible'],
            ];
        })->values();

        return response()->json([
            // "started" = we have pulled at least one article; everything else is the worklist.
            'started' => $rows->filter(fn ($r) => $r['last_harvested_at'] !== null)->values(),
            'next'    => $rows->filter(fn ($r) => $r['last_harvested_at'] === null)->values(),
        ]);
    }

    /**
     * GET /api/maintainer/journal-import/{slug}/articles — one journal's articles, lanes nested.
     */
    public function articles(Request $request, string $slug, HarvestEligibility $eligibility, ReconvertQueue $queue)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }

        $db = DB::connection('pgsql_admin');

        // Every version row for this journal's canonicals, joined on canonical_source_id so BOTH
        // lanes appear (a pointer join shows only the promoted one).
        $rows = $db->table('canonical_source as cs')
            ->leftJoin('library as l', 'l.canonical_source_id', '=', 'cs.id')
            ->where('cs.journal_source_id', $journal->id)
            ->orderByRaw('cs.cited_by_count DESC NULLS LAST')
            ->orderBy('cs.id')
            ->select([
                'cs.id as canonical_id', 'cs.title', 'cs.author', 'cs.year', 'cs.volume', 'cs.issue',
                'cs.doi', 'cs.cited_by_count', 'cs.is_oa', 'cs.oa_url', 'cs.pdf_url',
                'cs.auto_version_book',
                'l.book', 'l.has_nodes', 'l.listed', 'l.visibility', 'l.conversion_method',
                'l.foundation_source', 'l.completeness', 'l.completeness_reason',
                'l.pdf_url_status', 'l.created_at as lane_created_at',
            ])
            ->get();

        $flagged = $this->openFlagCountsByBook();

        $articles = [];
        foreach ($rows as $r) {
            if (! isset($articles[$r->canonical_id])) {
                $articles[$r->canonical_id] = [
                    'canonical_id'   => $r->canonical_id,
                    'title'          => $r->title,
                    'author'         => $r->author,
                    'year'           => $r->year,
                    'volume'         => $r->volume,
                    'issue'          => $r->issue,
                    'doi'            => $r->doi,
                    'cited_by_count' => $r->cited_by_count,
                    'is_oa'          => (bool) $r->is_oa,
                    'fetchable'      => (bool) ($r->oa_url || $r->pdf_url || $r->doi),
                    'version_book'   => $r->auto_version_book,
                    'lanes'          => [],
                ];
            }

            if (! $r->book || ($r->visibility ?? null) === 'deleted') {
                continue;
            }

            $articles[$r->canonical_id]['lanes'][] = [
                'book'              => $r->book,
                'lane'              => self::LANE_LABELS[$r->foundation_source] ?? ($r->foundation_source ?: 'other'),
                'foundation_source' => $r->foundation_source,
                'conversion_method' => $r->conversion_method,
                'has_nodes'         => (bool) $r->has_nodes,
                'listed'            => (bool) $r->listed,
                'visibility'        => $r->visibility,
                'completeness'      => $r->completeness,
                'completeness_reason' => $r->completeness_reason,
                'pdf_url_status'    => $r->pdf_url_status,
                'is_version'        => $r->book === $r->auto_version_book,
                // Has content, is not public, and cannot make itself public: the authenticity gate
                // did not confirm it, so no sweep will ever promote it. Distinct from a plain
                // `unlisted` sibling, which is unlisted precisely BECAUSE another lane won — that
                // one is correct and needs nobody. This one is waiting on a person.
                'needs_approval'    => (bool) $r->has_nodes
                    && ! $r->listed
                    && $r->book !== $r->auto_version_book
                    && ! in_array($r->conversion_method, AutoVersionResolver::SYSTEM_CONVERSION_METHODS, true),
                'open_flags'        => $flagged[$r->book]['count'] ?? 0,
                'maintainer_note'   => $flagged[$r->book]['note'] ?? null,
                'artifacts'         => $queue->artifactsFor($r->book),
                'fetch_trace'       => $this->fetchTrace($r->book),
                'created_at'        => $r->lane_created_at,
            ];
        }

        $estimate = $eligibility->estimateForJournal($journal->id);

        return response()->json([
            'journal' => [
                'slug'               => $journal->slug,
                'display_name'       => $journal->display_name,
                'publisher'          => $journal->publisher,
                'issn_l'             => $journal->issn_l,
                'openalex_source_id' => $journal->openalex_source_id,
                'is_diamond'         => (bool) $journal->is_diamond,
                'works_count'        => $journal->works_count,
                'cited_by_count'     => $journal->cited_by_count,
                'last_harvested_at'  => $journal->last_harvested_at?->toIso8601String(),
                'harvest_stats'      => $journal->harvest_stats ?? [],
                'public_page'        => '/j/' . $journal->slug,
            ],
            'estimate' => $estimate,
            'articles' => array_values($articles),
        ]);
    }

    /**
     * POST /api/maintainer/journal-import/promote/{book} — make this lane the version.
     *
     * The whole point of showing both lanes: once you can see that (say) the HTML conversion
     * kept the headings OCR dropped, you need one click to make it the copy readers get.
     */
    public function promote(Request $request, string $book, JournalVersionPromoter $promoter)
    {
        // `force` is the operator overruling the authenticity gate on a lane they have read. The
        // gate's job is to refuse when UNSURE, which is right for automation and wrong as a veto
        // over a person who has checked — an editorial with no reference list can never clear it,
        // and without an override such a work is importable but permanently unpublishable.
        $force = $request->boolean('force');
        $result = $promoter->promote($book, $force);

        if (! $result['promoted']) {
            $status = $result['reason'] === 'not_found' ? 404 : 422;

            return response()->json([
                'message' => "Cannot promote this lane: {$result['reason']}",
                'refusal' => $result['reason'],
                // Tells the console whether to offer "publish anyway": only the authenticity
                // refusal is overridable. no_content / not_linked describe a lane that cannot be
                // resolved at all, and no amount of human confidence changes that.
                'overridable' => str_starts_with((string) $result['reason'], 'not_a_system_version'),
            ], $status);
        }

        return response()->json([
            'promoted' => true,
            'demoted'  => $result['demoted'],
        ]);
    }

    /**
     * POST .../journal-import/resolve/{book} — close this lane's open flags without leaving the page.
     *
     * NOT the shared /maintainer/conversion resolve. That one calls
     * `ReconvertQueue::promoteApprovedHarvest`, which lists any unlisted system-acquired book it is
     * given — approval doubles as the listing gate there, because a flagged book is the only
     * version of its work. Here it isn't: a work carries sibling lanes and exactly one may be
     * public, so closing a note on the LOSING lane would quietly publish a second version of the
     * same article. Listing therefore happens only when this lane is the promoted one; otherwise
     * the flags close and the row stays unlisted, and ★ make version remains the only way to
     * publish a lane.
     */
    public function resolveFlags(Request $request, string $book, ReconvertQueue $queue)
    {
        $data = $request->validate([
            'resolution' => 'required|string|in:reconverted,refetched,dismissed',
        ]);

        $db = DB::connection('pgsql_admin');
        $row = $db->table('library')->where('book', $book)->first();
        if (! $row) {
            return response()->json(['message' => 'Lane not found.'], 404);
        }

        $resolved = \App\Models\ConversionFlag::resolveFor($book, $data['resolution']);

        $isPromoted = $row->canonical_source_id
            && $db->table('canonical_source')->where('id', $row->canonical_source_id)
                ->value('auto_version_book') === $book;

        $listed = $isPromoted ? $queue->promoteApprovedHarvest($book) : false;

        return response()->json([
            'resolved'     => $resolved,
            'listed'       => $listed,
            'is_promoted'  => $isPromoted,
        ]);
    }

    /**
     * POST .../journal-import/{slug}/run — fire one action and return its run id.
     *
     * Queued (JournalImportActionJob), because each of these either hits a publisher or runs OCR.
     * Two scopes: the article actions are the diagnoses an operator makes about a lane, and the
     * journal actions (`enumerate`, `import_all`) are the steps that fill the page in the first
     * place — see the job's docblock. Deliberately NOT a "reconvert" for the PDF lane: that book
     * has an `original.pdf` and an OCR cache on disk, so it goes through the existing, proven
     * `/api/books/{book}/reconvert` — one reconvert implementation, not two.
     *
     * `import_all` bills the admin who pressed it (`user_id`), exactly as the CLI bills `--user`.
     */
    public function run(Request $request, string $slug)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found.'], 404);
        }

        $action = (string) $request->input('action', 'import');
        if (! in_array($action, self::ACTIONS, true)) {
            return response()->json(['message' => "Unknown action \"{$action}\"."], 422);
        }

        $lanes = (string) $request->input('lanes', 'both');
        if (! in_array($lanes, ['pdf', 'html', 'both'], true)) {
            return response()->json(['message' => "lanes must be pdf, html or both."], 422);
        }

        $db = DB::connection('pgsql_admin');
        $canonicalId = $request->input('canonical_id');
        $book = $request->input('book');
        $journalScoped = in_array($action, self::JOURNAL_ACTIONS, true);
        $workLimit = null;

        if ($journalScoped) {
            // A journal action names no article; its target IS the journal, already resolved.
            $canonicalId = null;
            $book = null;

            if ($action === 'import_all') {
                $workLimit = (int) $request->input('limit', 5);
                if (! in_array($workLimit, self::WORK_LIMITS, true)) {
                    return response()->json([
                        'message' => 'limit must be one of: ' . implode(', ', self::WORK_LIMITS) . ' (0 = all eligible).',
                    ], 422);
                }
            }
        }

        // Validate the target up front so the operator gets a real error instead of a run row
        // that fails a second later on the worker.
        if ($action === 'import') {
            if (! $canonicalId || ! $db->table('canonical_source')->where('id', $canonicalId)
                ->where('journal_source_id', $journal->id)->exists()) {
                return response()->json(['message' => 'canonical_id must be a work of this journal.'], 422);
            }
        } elseif (! $journalScoped) {
            $lane = $book ? $db->table('library')->where('book', $book)->first() : null;
            if (! $lane) {
                return response()->json(['message' => 'Lane not found.'], 404);
            }
            if ($lane->foundation_source !== HtmlLaneCreator::FOUNDATION_SOURCE) {
                return response()->json([
                    'message' => 'Reconvert/re-fetch here is the HTML lane\'s path; a PDF lane reconverts from its own source.',
                ], 422);
            }
            $canonicalId = $lane->canonical_source_id;
        }

        // Refuse to pile a second run onto the same target — the actions replace a book's nodes,
        // so two at once would interleave writes. A JOURNAL-scoped run has no single target: it
        // may touch any work of the journal, so it excludes and is excluded by everything else on
        // that journal, in both directions.
        $inFlight = $db->table('journal_import_runs')
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->where(function ($q) use ($journal, $journalScoped, $canonicalId, $book) {
                // Always blocked by a journal-wide run already underway.
                $q->where(fn ($j) => $j->where('journal_source_id', $journal->id)
                    ->whereIn('action', self::JOURNAL_ACTIONS));

                $journalScoped
                    // A new journal-wide run also waits for any single article still being worked.
                    ? $q->orWhere('journal_source_id', $journal->id)
                    : $q->orWhere(fn ($a) => $a->where('canonical_source_id', $canonicalId)->orWhere('book', $book));
            })
            ->first();
        if ($inFlight) {
            return response()->json([
                'run_id'         => $inFlight->id,
                'already_running' => true,
                // Which run you joined matters when it isn't the one you pressed: pressing
                // "import 5" during an enumerate should say so, not silently show its progress.
                'action'         => $inFlight->action,
            ]);
        }

        $runId = (string) Str::uuid();
        $db->table('journal_import_runs')->insert([
            'id'                  => $runId,
            'journal_source_id'   => $journal->id,
            'canonical_source_id' => $canonicalId,
            'user_id'             => $request->user()?->id,
            'action'              => $action,
            'lanes'               => $lanes,
            'status'              => 'pending',
            'book'                => $book,
            'work_limit'          => $workLimit,
            'counts'              => '{}',
            'created_at'          => now(),
            'updated_at'          => now(),
        ]);

        JournalImportActionJob::dispatch($runId);

        return response()->json(['run_id' => $runId, 'already_running' => false]);
    }

    /**
     * GET .../journal-import/runs/{id} — poll a run.
     *
     * Carries the same stale-run watchdog the source harvester uses: a worker that dies mid-job
     * leaves the row 'running' forever, and a page that polls it forever looks like a hang.
     */
    public function runStatus(Request $request, string $id)
    {
        $db = DB::connection('pgsql_admin');
        $run = $db->table('journal_import_runs')->where('id', $id)->first();
        if (! $run) {
            return response()->json(['message' => 'Run not found.'], 404);
        }

        if (in_array($run->status, ['pending', 'running'], true)
            && strtotime((string) $run->updated_at) < strtotime('-30 minutes')) {
            $db->table('journal_import_runs')->where('id', $id)->update([
                'status'     => 'failed',
                'error'      => 'no progress for 30 minutes — the worker died or was never running',
                'updated_at' => now(),
            ]);
            $run->status = 'failed';
            $run->error = 'no progress for 30 minutes — the worker died or was never running';
        }

        return response()->json([
            'id'          => $run->id,
            'status'      => $run->status,
            'action'      => $run->action,
            'lanes'       => $run->lanes,
            'book'        => $run->book,
            'step_detail' => $run->step_detail,
            'counts'      => json_decode((string) $run->counts, true) ?: [],
            'error'       => $run->error,
        ]);
    }

    /**
     * Per-journal article counts in ONE query — total canonicals, how many carry a promoted
     * version, and how many are still eligible (the same predicate HarvestEligibility uses).
     *
     * @return array<string, array{total:int, imported:int, eligible:int}>
     */
    private function articleCountsByJournal(): array
    {
        $rows = DB::connection('pgsql_admin')
            ->table('canonical_source')
            ->whereNotNull('journal_source_id')
            ->selectRaw('journal_source_id')
            ->selectRaw('COUNT(*) as total')
            ->selectRaw('COUNT(auto_version_book) as imported')
            ->selectRaw(
                "COUNT(*) FILTER (WHERE auto_version_book IS NULL AND is_oa = true AND ("
                . "(pdf_url IS NOT NULL AND pdf_url <> '') OR "
                . "(oa_url IS NOT NULL AND oa_url <> '') OR "
                . "(doi IS NOT NULL AND doi <> ''))) as eligible"
            )
            ->groupBy('journal_source_id')
            ->get();

        $out = [];
        foreach ($rows as $r) {
            $out[$r->journal_source_id] = [
                'total'    => (int) $r->total,
                'imported' => (int) $r->imported,
                'eligible' => (int) $r->eligible,
            ];
        }

        return $out;
    }

    /**
     * Open conversion-flag counts keyed by book. Default connection, matching
     * ReconvertQueue::openFlagsGrouped — flags are not RLS'd, and reading them through the
     * admin connection here would only diverge from how the rest of the app sees them.
     */
    private function openFlagCountsByBook(): array
    {
        $out = [];
        // The maintainer's own note comes back with the count: it is written into the open flags'
        // details and rides the case bundle into dev, so the page has to be able to show what is
        // already there rather than silently offering an empty box over an existing note.
        foreach (DB::table('conversion_flags')->where('status', 'open')->get(['book', 'details']) as $flag) {
            $details = is_array($flag->details) ? $flag->details : (json_decode((string) $flag->details, true) ?: []);
            $out[$flag->book]['count'] = ($out[$flag->book]['count'] ?? 0) + 1;
            $out[$flag->book]['note'] ??= $details['maintainer_note'] ?? null;
        }

        return $out;
    }

    /**
     * The lane's acquisition evidence: which OA copy won, what the body gate said, how complete
     * the copy looked. Written on every fetch() exit path but surfaced nowhere until now.
     */
    private function fetchTrace(string $book): ?array
    {
        $path = resource_path("markdown/{$book}/fetch_trace.json");
        if (! is_file($path)) {
            return null;
        }

        $data = json_decode((string) file_get_contents($path), true);
        if (! is_array($data)) {
            return null;
        }

        return array_intersect_key($data, array_flip([
            'candidates', 'won_host', 'won_source', 'won_version', 'won_license',
            'completeness', 'completeness_reason', 'body_verdict', 'body_reason', 'traced_at',
        ]));
    }
}
