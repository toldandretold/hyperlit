<?php

namespace App\Http\Controllers\Maintainer;

use App\Http\Controllers\Controller;
use App\Http\Controllers\Maintainer\Concerns\BuildsImportLanes;
use App\Jobs\JournalImportActionJob;
use App\Models\JournalSource;
use App\Services\Conversion\ConversionLintReport;
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
 * Web route: admin gated by the `admin.page` route middleware, non-admins get 404 (the page isn't advertised —
 * mirrors MaintainerController/JobsController). API routes sit behind the auth:sanctum + admin
 * middleware group in routes/api.php.
 */
class JournalImportController extends Controller
{
    /** The reason on a flag opened by confirming a lint finding (and nothing else). */
    private const LINT_FLAG_REASON = 'Confirmed conversion-lint finding';

    use BuildsImportLanes;

    /** Everything the console can fire; see JournalImportActionJob for what each one means. */
    private const ACTIONS = ['import', 'reconvert_html', 'refetch_html', 'enumerate', 'import_all', 'reconvert_all'];

    /**
     * The actions that act on the JOURNAL rather than one article. They take no `canonical_id`
     * and no `book`, and they cannot safely overlap anything else on the same journal — an
     * `import_all` and a per-article `import` racing on the same work would interleave node
     * writes on one book.
     */
    private const JOURNAL_ACTIONS = ['enumerate', 'import_all', 'reconvert_all'];

    /** Caps offered for a bulk import. 0 = every eligible work — deliberate, never the default. */
    private const WORK_LIMITS = [5, 25, 100, 0];

    /**
     * Dollar ceilings for a self-continuing import chain.
     *
     * A chain keeps re-dispatching itself for as long as the journal has work, so unlike a single
     * run its spend is not bounded by anything the operator can see at press time. The DEFAULT is
     * roughly a mid-size journal at observed rates (tripleC: ~$0.041 an article, ~960 articles);
     * the MAX is a backstop against a typo in the field, not a policy — a bigger corpus is a
     * deliberate decision that belongs in config, not in a number someone typed once.
     */
    private const DEFAULT_CHAIN_SPEND_CAP = 40.0;
    private const MAX_CHAIN_SPEND_CAP = 250.0;

    /** GET /maintainer/journal-import — pick a journal. */
    public function index(Request $request)
    {
        return view('maintainer-journal-import');
    }

    /** GET /maintainer/journal-import/{slug} — work one journal. */
    public function show(Request $request, string $slug)
    {
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
                // Read-only here (the row is an <a>); the toggle lives on the detail page.
                'certified'           => $j->certified_at !== null,
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

        $articles = $this->foldArticles($rows, $this->openFlagCountsByBook(), $queue);

        $estimate = $eligibility->estimateForJournal($journal->id);

        // An in-flight journal-scoped run rides along so a RELOADED page re-attaches its poll
        // instead of going silent for the rest of a 50-minute import. The poll lives in a promise
        // chain with no persisted run id, so without this a refresh is indistinguishable from a
        // dead worker — which is exactly what it looked like.
        //
        // Journal-scoped only (`canonical_source_id` null): a per-article action reports into its
        // own bar, and re-attaching it to the journal bar would put one article's progress where
        // the bulk run's belongs.
        $activeRun = $db->table('journal_import_runs')
            ->where('journal_source_id', $journal->id)
            ->whereNull('canonical_source_id')
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->orderByDesc('created_at')
            ->first(['id', 'status', 'action', 'lanes', 'work_limit', 'step_detail', 'progress',
                     'continue_until_done', 'chain_position', 'chain_spend', 'spend_cap']);

        if ($activeRun) {
            $activeRun->progress = json_decode((string) $activeRun->progress, true) ?: null;
        }

        return response()->json([
            'active_run' => $activeRun,
            // A reconvert_all run reports `completed` when it has finished QUEUEING —
            // the conversions themselves drain through the import worker for hours
            // afterwards, with every queued book sitting content-cleared ("no content"
            // badges). With no signal here the console looked broken and got the
            // button re-pressed over a 941-book corpus (2026-09-15). Non-zero means
            // "still draining"; the page shows it and polls /reconvert-backlog.
            'reconvert_backlog' => $this->pendingConversionJobs($journal->id),
            'journal' => [
                'slug'               => $journal->slug,
                'display_name'       => $journal->display_name,
                // The hero override, RAW (null when unset) — the console edits the override,
                // not the resolved name, so an empty box means "use OpenAlex's full title".
                'hero_name'          => $journal->hero_name,
                'publisher'          => $journal->publisher,
                'issn_l'             => $journal->issn_l,
                'openalex_source_id' => $journal->openalex_source_id,
                'is_diamond'         => (bool) $journal->is_diamond,
                'certified'          => $journal->certified_at !== null,
                'works_count'        => $journal->works_count,
                'cited_by_count'     => $journal->cited_by_count,
                'last_harvested_at'  => $journal->last_harvested_at?->toIso8601String(),
                'harvest_stats'      => $journal->harvest_stats ?? [],
                'public_page'        => '/j/' . $journal->slug,
            ],
            'estimate' => $estimate,
            'articles' => $articles,
        ]);
    }

    /**
     * GET /api/maintainer/journal-import/{slug}/reconvert-backlog — the drain poll.
     *
     * Deliberately tiny (one count) so the console can poll it every ~20s for the
     * hours a 900-book reconvert_all takes to drain, without re-folding 950 articles
     * per tick the way /articles does.
     */
    public function reconvertBacklog(Request $request, string $slug)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }

        return response()->json(['pending' => $this->pendingConversionJobs($journal->id)]);
    }

    /**
     * GET /api/maintainer/journal-import/{slug}/lint — "search this journal for problems".
     *
     * Every lane with content, ranked by the structural defects its stored nodes show
     * (ConversionLint), plus the before/after against the journal's snapshot when one was taken.
     * Separate from /articles on purpose: that payload is what the page needs to draw at all,
     * and this one can be slow the first time (a cold journal is computed across several
     * requests — `pending` says how many lanes are still to do, and the page asks again).
     */
    public function lint(Request $request, string $slug, ConversionLintReport $report)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }

        $books = $this->lintableBooks($journal->id);
        $result = $report->forBooks($books);
        $compare = $result['pending'] === 0
            ? $report->compareWithSnapshot($journal->id, $books, $result)
            : null;

        $payload = [];
        foreach ($result['books'] as $book => $b) {
            $newKeys = array_flip($compare['new'][$book] ?? []);
            $findings = array_map(
                fn ($f) => $f + ['is_new' => isset($newKeys[$f['key']])],
                $b['findings'],
            );
            // New findings first: with the list capped, the ones a reconvert INTRODUCED are the
            // ones that must never be cut off.
            usort($findings, fn ($x, $y) => $y['is_new'] <=> $x['is_new']);
            $payload[$book] = [
                'score'          => $b['score'],
                'counts'         => $b['counts'],
                'findings'       => array_slice($findings, 0, ConversionLintReport::FINDINGS_CAP),
                'findings_total' => count($findings),
                'new'            => count($newKeys),
                'confirmed'      => count(array_filter($findings, fn ($f) => $f['confirmed'])),
                // Judged false alarms: out of every count above, kept so the verdict can be undone.
                'dismissed'      => array_slice($b['dismissed'], 0, ConversionLintReport::FINDINGS_CAP),
            ];
        }

        if ($compare) {
            // Per-book keys were only needed to mark the findings above.
            $compare['new_books'] = count($compare['new']);
            unset($compare['new']);
        }

        return response()->json([
            'pending' => $result['pending'],
            'total'   => count($books),
            'books'   => (object) $payload,
            'compare' => $compare,
            // Any verdict at all makes the cases download worth offering.
            'reviewed' => count($report->reviewRows(array_keys($books))),
        ]);
    }

    /**
     * POST /api/maintainer/journal-import/{slug}/lint/review — a human's verdict on one finding.
     *
     * `false_alarm` takes it out of the lane's count for good (keyed by detector + excerpt, so it
     * stays dismissed across reconverts). `real` confirms it AND writes it into the lane's
     * maintainer note — the note already opens a case and already rides the case bundle, so a
     * confirmed finding reaches whoever fixes the converter by the road that exists. A null
     * verdict withdraws either.
     */
    public function lintReview(Request $request, string $slug, ConversionLintReport $report)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }
        $data = $request->validate([
            'book'      => 'required|string|max:255',
            'detector'  => 'required|string|max:40|regex:/^[a-z_]+$/',
            'excerpt'   => 'required|string|max:400',
            'startLine' => 'nullable|string|max:40',
            'verdict'   => 'present|nullable|in:' . ConversionLintReport::VERDICT_REAL . ',' . ConversionLintReport::VERDICT_FALSE_ALARM,
        ]);
        if (! array_key_exists($data['book'], $this->lintableBooks($journal->id))) {
            return response()->json(['message' => 'That book is not a lane of this journal.'], 404);
        }

        $finding = ['detector' => $data['detector'], 'excerpt' => $data['excerpt'],
                    'startLine' => (string) ($data['startLine'] ?? '')];
        $report->review($data['book'], $finding, $data['verdict'], $request->user()?->name);
        $this->syncConfirmedFindingNote(
            $data['book'], $finding, $data['verdict'] === ConversionLintReport::VERDICT_REAL, $request->user()?->name);

        return response()->json(['ok' => true, 'key' => \App\Services\Conversion\ConversionLint::key($finding)]);
    }

    /**
     * GET /api/maintainer/journal-import/{slug}/lint/cases — the cases worth taking to a dev machine.
     *
     * NOT every lane with a confirmed problem: a converter fix is per KIND of defect, and a bundle
     * is the whole PDF plus its OCR, so a journal's worth would be hundreds of megabytes of the
     * same bug. One example lane per confirmed kind — the lane with the most confirmed findings of
     * that kind — plus `lint-review.json`, which lists EVERY verdict (the confirmed ones the fix
     * should clear, and the false alarms, which are evidence for tightening a detector).
     * One outer tar of ordinary book:export bundles; `book:import-cases --downloads` unpacks it.
     */
    public function lintCases(Request $request, string $slug, ConversionLintReport $report)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }

        $books = $this->lintableBooks($journal->id);
        $rows = $report->reviewRows(array_keys($books));
        $sample = $request->boolean('sample');
        if ($rows === [] && ! $sample) {
            return response()->json(['message' => 'Nothing reviewed yet — confirm or dismiss a problem first.'], 422);
        }

        // detector => book => confirmed count; the busiest lane is that kind's example.
        $tally = [];
        foreach ($rows as $row) {
            if ($row['verdict'] === ConversionLintReport::VERDICT_REAL) {
                $tally[$row['detector']][$row['book']] = ($tally[$row['detector']][$row['book']] ?? 0) + 1;
            }
        }
        $examples = [];   // book => kinds it stands for
        foreach ($tally as $detector => $perBook) {
            arsort($perBook);
            // Prefer a lane already chosen for another kind when it ties for the lead — fewer bundles.
            $best = array_key_first($perBook);
            foreach ($perBook as $book => $n) {
                if ($n === $perBook[$best] && isset($examples[$book])) {
                    $best = $book;
                    break;
                }
            }
            $examples[$best][] = $detector;
        }

        // ?sample=1 — nobody has reviewed anything (or not every kind): take examples straight
        // from the lint. One lane per kind, and for a kind the last reconvert made WORSE the two
        // lanes with the most NEW findings of it, because those are the regression to diagnose.
        $sampled = [];
        $sampledFindings = [];
        if ($sample) {
            $result = $report->forBooks($books);
            if ($result['pending'] > 0) {
                return response()->json(['message' => 'Still checking this journal for problems — try again in a moment.'], 409);
            }
            $compare = $report->compareWithSnapshot($journal->id, $books, $result);
            $perKind = [];   // detector => book => [new, all]
            foreach ($result['books'] as $book => $b) {
                $newKeys = array_flip($compare['new'][$book] ?? []);
                foreach ($b['findings'] as $f) {
                    $perKind[$f['detector']][$book] ??= [0, 0];
                    $perKind[$f['detector']][$book][0] += isset($newKeys[$f['key']]) ? 1 : 0;
                    $perKind[$f['detector']][$book][1] += 1;
                }
            }
            foreach ($perKind as $detector => $perBook) {
                uasort($perBook, fn ($x, $y) => [$y[0], $y[1]] <=> [$x[0], $x[1]]);
                $top = array_key_first($perBook);
                $take = $perBook[$top][0] > 0
                    ? array_keys(array_filter(array_slice($perBook, 0, 2, true), fn ($n) => $n[0] > 0))
                    : [$top];
                foreach ($take as $book) {
                    $sampled[$book][] = $detector;
                }
            }
            foreach ($sampled as $book => $kinds) {
                $newKeys = array_flip($compare['new'][$book] ?? []);
                foreach ($result['books'][$book]['findings'] as $f) {
                    if (in_array($f['detector'], $kinds, true)) {
                        $sampledFindings[] = ['book' => $book, 'detector' => $f['detector'],
                            'startLine' => $f['startLine'], 'excerpt' => $f['excerpt'],
                            'is_new' => isset($newKeys[$f['key']])];
                    }
                }
            }
        }

        $dir = storage_path('app/book-exports/lint-cases-' . Str::random(12));
        \Illuminate\Support\Facades\File::ensureDirectoryExists($dir);
        $members = ['lint-review.json'];
        $failed = [];
        foreach (array_unique(array_merge(array_keys($examples), array_keys($sampled))) as $book) {
            $out = "{$dir}/{$book}.tar.gz";
            $exit = \Illuminate\Support\Facades\Artisan::call('book:export', [
                'book' => $book, '--out' => $out, '--origin' => 'journal-import',
            ]);
            if ($exit === 0 && is_file($out)) {
                $members[] = "{$book}.tar.gz";
            } else {
                $failed[] = $book;
            }
        }

        $verdict = fn (string $v) => array_values(array_map(
            fn ($r) => ['book' => $r['book'], 'detector' => $r['detector'], 'startLine' => $r['start_line'], 'excerpt' => $r['excerpt']],
            array_filter($rows, fn ($r) => $r['verdict'] === $v)));
        file_put_contents("{$dir}/lint-review.json", json_encode([
            'journal'       => $journal->display_name,
            'slug'          => $journal->slug,
            'exported_at'   => now()->toIso8601String(),
            'lint_version'  => \App\Services\Conversion\ConversionLint::VERSION,
            'examples'      => $examples,
            // Unreviewed lanes picked by the lint itself (?sample=1) and what it found in them.
            'sampled'          => $sampled,
            'sampled_findings' => $sampledFindings,
            'export_failed' => $failed,
            'confirmed'     => $verdict(ConversionLintReport::VERDICT_REAL),
            'false_alarms'  => $verdict(ConversionLintReport::VERDICT_FALSE_ALARM),
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));

        $outer = "{$dir}.tar";
        $tar = new \Symfony\Component\Process\Process(array_merge(['tar', '-cf', $outer, '-C', $dir], $members));
        $tar->run();
        \Illuminate\Support\Facades\File::deleteDirectory($dir);
        if (! $tar->isSuccessful() || ! is_file($outer)) {
            return response()->json(['message' => 'Could not build the cases archive — see logs.'], 500);
        }

        return response()->download($outer, "lint-cases-{$journal->slug}.tar")->deleteFileAfterSend(true);
    }

    /**
     * Keep the lane's maintainer note in step with its confirmed findings: one line per finding,
     * tagged with the finding's key so the same line can be found and removed again. Opens a
     * `manual` flag when the lane has none (as MaintainerController::note does — a confirmed
     * problem with no case is a problem nobody will pick up), and closes that flag again if
     * un-confirming leaves it with nothing to say.
     */
    private function syncConfirmedFindingNote(string $book, array $finding, bool $confirmed, ?string $by): void
    {
        $key = \App\Services\Conversion\ConversionLint::key($finding);
        $flags = \App\Models\ConversionFlag::where('book', $book)->where('status', 'open')->get();
        if ($flags->isEmpty()) {
            if (! $confirmed) {
                return;
            }
            $flags = collect([\App\Models\ConversionFlag::create([
                'book'    => $book,
                'source'  => \App\Models\ConversionFlag::SOURCE_MANUAL,
                'reason'  => self::LINT_FLAG_REASON,
                'status'  => 'open',
                'details' => [],
            ])]);
        }

        $where = $finding['startLine'] !== '' ? " (node {$finding['startLine']})" : '';
        $line = "✓ [{$key}]{$where} " . Str::limit(preg_replace('/\s+/u', ' ', $finding['excerpt']), 170);

        foreach ($flags as $flag) {
            $details = $flag->details ?? [];
            $lines = array_values(array_filter(
                preg_split('/\R/u', (string) ($details['maintainer_note'] ?? '')),
                fn ($l) => ! str_contains($l, "[{$key}]"),
            ));
            if ($confirmed) {
                $lines[] = $line;
            }
            $note = trim(implode("\n", $lines));

            if ($note === '') {
                if ($flag->reason === self::LINT_FLAG_REASON && $flag->source === \App\Models\ConversionFlag::SOURCE_MANUAL) {
                    $flag->delete();     // we opened it for this, and nothing is left of it
                    continue;
                }
                unset($details['maintainer_note'], $details['noted_by'], $details['noted_at']);
            } else {
                $details['maintainer_note'] = Str::limit($note, 3990, '');
                $details['noted_by'] = $by;
                $details['noted_at'] = now()->toIso8601String();
            }
            $flag->details = $details;
            $flag->save();
        }
    }

    /**
     * POST /api/maintainer/journal-import/{slug}/lint/snapshot — freeze "before".
     *
     * Refused while the journal is not in a state worth freezing: lanes still to lint (the
     * snapshot would be partial), or conversions still queued (a reconvert_all clears each book at
     * enqueue, so a mid-drain snapshot records gutted books as clean and every later comparison
     * reads as a regression).
     */
    public function lintSnapshot(Request $request, string $slug, ConversionLintReport $report)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }

        if (($queued = $this->pendingConversionJobs($journal->id)) > 0) {
            return response()->json([
                'message' => "{$queued} conversion(s) are still queued for this journal — snapshot once they have run.",
            ], 409);
        }

        $books = $this->lintableBooks($journal->id);
        $result = $report->forBooks($books);
        if ($result['pending'] > 0) {
            return response()->json([
                'message' => "{$result['pending']} lane(s) are still being checked — try again in a moment.",
                'pending' => $result['pending'],
            ], 409);
        }

        return response()->json([
            'snapshot' => $report->saveSnapshot($journal->id, $books, $result, $request->user()?->name),
        ]);
    }

    /** DELETE /api/maintainer/journal-import/{slug}/lint/snapshot — stop comparing. */
    public function lintSnapshotDelete(Request $request, string $slug, ConversionLintReport $report)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }
        $report->deleteSnapshot($journal->id);

        return response()->json(['ok' => true]);
    }

    /**
     * The journal's lanes that have something to lint: book => content clock. Every lane, not
     * just the promoted one — comparing a PDF lane's problems with its HTML sibling's is half of
     * what this console is for.
     *
     * @return array<string, int>
     */
    private function lintableBooks(string $journalId): array
    {
        return DB::connection('pgsql_admin')->table('library as l')
            ->join('canonical_source as cs', 'cs.id', '=', 'l.canonical_source_id')
            ->where('cs.journal_source_id', $journalId)
            ->where('l.has_nodes', true)
            ->where('l.book', 'not like', '%/%')
            ->where(fn ($q) => $q->whereNull('l.visibility')->orWhere('l.visibility', '!=', 'deleted'))
            ->pluck('l.timestamp', 'l.book')
            ->map(fn ($t) => (int) $t)
            ->all();
    }

    /**
     * How many queued ProcessDocumentImportJobs belong to this journal's lanes.
     *
     * Matched by extracting the book uuid from the job payload (journal lanes are
     * always uuid-minted by AutoVersionCreator) — the same payload-inspection
     * technique as ImportQueuePosition, kept set-based because a reconvert_all
     * fan-out means ~900 rows. Counts BOTH import lanes: bulk fan-outs ride
     * `default`, but a book the operator then reconverts by hand rides `imports`.
     */
    private function pendingConversionJobs(string $journalId): int
    {
        // EVERY uuid in the payload is tried against the journal's lanes, not just the
        // first — a queue payload's first uuid is the JOB's own `uuid` field, and the
        // book id (journal lanes are always uuid-minted by AutoVersionCreator) sits
        // further in, inside the serialized command. The job uuid is random and matches
        // no library row, so the join quietly ignores it.
        $row = DB::connection('pgsql_admin')->selectOne(
            "select count(*) as n
             from jobs j
             where j.queue in (?, 'default')
               and j.payload like '%ProcessDocumentImportJob%'
               and exists (
                 select 1
                 from regexp_matches(j.payload, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') m
                 join library l on l.book = m[1]
                 join canonical_source cs on cs.id = l.canonical_source_id
                 where cs.journal_source_id = ?
               )",
            [\App\Jobs\ProcessDocumentImportJob::QUEUE_INTERACTIVE, $journalId],
        );

        return (int) ($row->n ?? 0);
    }

    /**
     * POST /api/maintainer/journal-import/{slug}/certify — put this journal on the homepage.
     *
     * Certification is a PERSON vouching for a journal they have read the conversions of, which
     * is a different claim from `is_diamond` (DOAJ's machine-checkable fact about APCs). Only
     * certified journals are listed in the homepage copy, and the homepage additionally drops any
     * with no readable article — so this flag says "worth showing", never "has content".
     *
     * Synchronous, and deliberately NOT one of the ACTIONS: enumerate/import_all are queued
     * because they fetch, OCR and cost money, and they take the journal's in-flight exclusion
     * lock. A one-column write must not block an import running beside it, so this follows the
     * promote/resolveFlags precedent instead.
     */
    public function certify(Request $request, string $slug)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }

        $certified = $request->boolean('certified');
        $journal->certified_at = $certified ? now() : null;
        $journal->save();

        // The homepage's certified list is cached (stale-while-revalidate);
        // busting it here keeps the operator's toggle live on the next request
        // — the liveness the list had back when it ran uncached.
        \Illuminate\Support\Facades\Cache::forget(\App\Services\JournalHarvest\CertifiedJournalsQuery::CACHE_KEY);

        return response()->json([
            'certified'    => $journal->certified_at !== null,
            'certified_at' => $journal->certified_at?->toIso8601String(),
        ]);
    }

    /**
     * POST /api/maintainer/journal-import/{slug}/hero-name — the short name for the public hero.
     *
     * The /j/{slug} lockup sizes the colon squares to the rendered title block, so a venue that
     * registered its name as a sentence ("… Open Access Journal for a Global Sustainable
     * Information Society") turns the mark into two squares floating 300px apart. There is no
     * machine answer to "what is this journal actually called" — tripleC's own masthead says
     * "tripleC" — so it is an operator field.
     *
     * Writes hero_name, never display_name: journal:sync-registry overwrites display_name from
     * OpenAlex on every run, and the full name is what the <title>, the meta description and the
     * JSON-LD need. Empty clears the override. Synchronous and lock-free, like certify.
     */
    public function heroName(Request $request, string $slug)
    {
        $journal = JournalSource::where('slug', $slug)->first();
        if (! $journal) {
            return response()->json(['message' => 'Journal not found'], 404);
        }

        $validated = $request->validate([
            'hero_name' => 'nullable|string|max:120',
        ]);

        $name = trim((string) ($validated['hero_name'] ?? ''));
        $journal->hero_name = $name === '' ? null : $name;
        $journal->save();

        return response()->json([
            'hero_name'  => $journal->hero_name,
            'hero_title' => $journal->heroTitle(),
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

        // A scope shelf (the shelf-import console's collection) is not
        // reachable through the work's own journal registration, so the
        // sibling swap there has to be asked for explicitly. Public-only —
        // the same rule every shelf-scoped console applies.
        $scopeShelfId = (string) $request->input('shelf_id', '');
        if (Str::isUuid($scopeShelfId)) {
            $shelfExists = DB::connection('pgsql_admin')->table('shelves')
                ->where('id', $scopeShelfId)
                ->where('visibility', 'public')
                ->exists();
            if ($shelfExists && $result['canonical_id']) {
                $promoter->reshelveOnShelf($scopeShelfId, $result['canonical_id'], $book);
            }
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
     * journal actions (`enumerate`, `import_all`, `reconvert_all`) are the steps that fill and
     * refresh the page — see the job's docblock. `reconvert_all` is the odd one: it spends nothing
     * and touches no publisher, but it still takes the journal-wide lock, because it rewrites the
     * nodes of every book in scope and must not interleave with an import doing the same.
     *
     * The single-article PDF reconvert is deliberately NOT here: that book has an `original.pdf`
     * and an OCR cache on disk, so it goes through the existing, proven
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

        // `html_first` is a BULK strategy, not a lane: it tries the free publisher page per work and
        // only buys OCR when that yields nothing publishable. Meaningless for the article-scoped
        // actions, which name one lane to act on.
        $lanes = (string) $request->input('lanes', 'both');
        $allowed = $action === 'import_all' ? ['pdf', 'html', 'both', 'html_first'] : ['pdf', 'html', 'both'];
        if (! in_array($lanes, $allowed, true)) {
            return response()->json(['message' => 'lanes must be one of: ' . implode(', ', $allowed) . '.'], 422);
        }

        $db = DB::connection('pgsql_admin');
        $canonicalId = $request->input('canonical_id');
        $book = $request->input('book');
        $journalScoped = in_array($action, self::JOURNAL_ACTIONS, true);
        $workLimit = null;
        $continue = false;
        $spendCap = null;

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

                $continue = $request->boolean('continue_until_done');
                if ($continue) {
                    // A chain re-dispatches itself unattended, so it never runs uncapped: the cap
                    // is the operator's stated ceiling for the WHOLE chain, clamped to a
                    // configured maximum so a fat-fingered field cannot authorise an unbounded
                    // spend. Enforced by the job before each successor is enqueued.
                    $spendCap = min(
                        max((float) $request->input('spend_cap', self::DEFAULT_CHAIN_SPEND_CAP), 0.01),
                        self::MAX_CHAIN_SPEND_CAP,
                    );
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
            'continue_until_done' => $continue,
            'spend_cap'           => $spendCap,
            'chain_spend'         => 0,
            'chain_position'      => 1,
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
            // The live beat, as fields. Null on a run dispatched before the column existed (or by
            // a pre-deploy worker) — the console falls back to `step_detail`, which still carries
            // the same n/total as prose.
            'progress'    => json_decode((string) $run->progress, true) ?: null,
            'error'       => $run->error,
            // The chain, so the console can follow a self-continuing import across run rows instead
            // of reporting "done" at the end of link 1 of 12. `next_run_id` rides inside `counts`,
            // written by the job as it enqueues the successor.
            'work_limit'          => $run->work_limit,
            'continue_until_done' => (bool) $run->continue_until_done,
            'chain_position'      => (int) $run->chain_position,
            'chain_spend'         => (float) $run->chain_spend,
            'spend_cap'           => $run->spend_cap === null ? null : (float) $run->spend_cap,
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

}
