<?php

namespace App\Http\Controllers\Maintainer\Concerns;

use App\Jobs\JournalImportActionJob;
use App\Models\ConversionFlag;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\Conversion\ImportConsoleScope;
use App\Services\Conversion\ReconvertQueue;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * What /maintainer/journal-import and /maintainer/shelf-import share on the server.
 *
 * The article/lane payload: fold version rows (one per `library` sibling, joined on
 * canonical_source_id so ALL lanes appear) into articles with lanes nested, each lane carrying
 * its acquisition evidence. And the scope-wide run machinery — collision guard, run row, the
 * re-attach and drain signals — written against an ImportConsoleScope, so the two consoles
 * cannot differ in how a bulk run is started, followed or refused. Each controller keeps only
 * what is genuinely its own: which actions it offers and how it validates a target.
 */
trait BuildsImportLanes
{
    /** Lane identity: which foundation_source minted a row, and what to call it in the UI. */
    private static array $laneLabels = [
        'canonical_pdf_vacuum' => 'pdf',
        'journal_html'         => 'html',
        'ar5iv_latexml'        => 'ar5iv',
    ];

    /**
     * Resolve the route's scope key (a journal slug, a shelf uuid) to the scope it names, or null
     * when there is no such journal / public shelf. Everything scope-keyed below goes through it,
     * which is what keeps a feature from landing on one console only.
     */
    abstract protected function consoleScope(string $key): ?ImportConsoleScope;

    /** The 404 for a key that names nothing. */
    abstract protected function scopeNotFound(): JsonResponse;

    /** The canonical × library columns both consoles fold into articles and lanes. */
    private function laneSelectColumns(): array
    {
        return [
            'cs.id as canonical_id', 'cs.title', 'cs.author', 'cs.year', 'cs.volume', 'cs.issue',
            'cs.doi', 'cs.cited_by_count', 'cs.is_oa', 'cs.oa_url', 'cs.pdf_url',
            'cs.auto_version_book',
            'l.book', 'l.has_nodes', 'l.listed', 'l.visibility', 'l.conversion_method',
            'l.foundation_source', 'l.completeness', 'l.completeness_reason',
            'l.pdf_url_status', 'l.created_at as lane_created_at',
        ];
    }

    /**
     * What a scope-wide run is doing, riding along on the `articles` payload.
     *
     * `active_run` re-attaches the poll after a reload. `reconvert_backlog` covers the gap AFTER
     * it: a reconvert_all run reports `completed` when it has finished QUEUEING, and the
     * conversions then drain through the import worker for hours with every queued book sitting
     * content-cleared ("no content" badges). With no signal the console looked broken and got the
     * button re-pressed over a 941-book corpus (2026-09-15). Non-zero means "still draining"; the
     * page shows it and polls /reconvert-backlog.
     *
     * @return array{active_run: ?object, reconvert_backlog: int}
     */
    private function scopePayload(ImportConsoleScope $scope): array
    {
        return [
            'active_run'        => $scope->activeRun(),
            'reconvert_backlog' => $scope->pendingConversionJobs(),
        ];
    }

    /**
     * GET …/{key}/reconvert-backlog — the drain poll.
     *
     * Deliberately tiny (one count) so the console can poll it every ~20s for the hours a
     * 900-book reconvert_all takes to drain, without re-folding 950 articles per tick the way
     * /articles does.
     */
    public function reconvertBacklog(Request $request, string $key)
    {
        $scope = $this->consoleScope($key);
        if (! $scope) {
            return $this->scopeNotFound();
        }

        return response()->json(['pending' => $scope->pendingConversionJobs()]);
    }

    /**
     * The run a new one would collide with, or null.
     *
     * The actions replace a book's nodes, so two at once would interleave writes. A SCOPE-wide
     * run has no single target — it may touch any work in the scope — so it excludes, and is
     * excluded by, everything else on that scope, in both directions.
     *
     * @param string[] $scopeWideActions the actions that target the whole scope
     */
    private function inFlightRun(
        ImportConsoleScope $scope,
        array $scopeWideActions,
        bool $scopeWide,
        ?string $canonicalId,
        ?string $book,
    ): ?object {
        $column = $scope->runColumn();

        return DB::connection('pgsql_admin')->table('journal_import_runs')
            ->whereIn('status', ['pending', 'running'])
            ->where('updated_at', '>', now()->subHour())
            ->where(function ($q) use ($scope, $column, $scopeWideActions, $scopeWide, $canonicalId, $book) {
                // Always blocked by a scope-wide run already underway.
                $q->where(fn ($s) => $s->where($column, $scope->id)->whereIn('action', $scopeWideActions));

                $scopeWide
                    // A new scope-wide run also waits for any single article still being worked.
                    ? $q->orWhere($column, $scope->id)
                    : $q->orWhere(fn ($a) => $a->where('canonical_source_id', $canonicalId)->orWhere('book', $book));
            })
            ->first();
    }

    /** The response for a press that joined a run already in flight. */
    private function joinedRunResponse(object $inFlight): JsonResponse
    {
        return response()->json([
            'run_id'          => $inFlight->id,
            'already_running' => true,
            // Which run you joined matters when it isn't the one you pressed: pressing
            // "import 5" during an enumerate should say so, not silently show its progress.
            'action'          => $inFlight->action,
        ]);
    }

    /**
     * Refuse a second `reconvert_all` while the first is still DRAINING.
     *
     * The run row is no guard here: it goes `completed` the moment queueing finishes, hours
     * before the conversions have run, and BookReconverter only skips a book whose queued marker
     * is under thirty minutes old — so a second press mid-drain clears and re-queues every book
     * that has been waiting longer than that. The console warns ("do NOT press reconvert all
     * again"); this is the half that does not depend on anyone reading it.
     */
    private function drainingRefusal(ImportConsoleScope $scope, string $action): ?JsonResponse
    {
        if ($action !== 'reconvert_all') {
            return null;
        }
        $queued = $scope->pendingConversionJobs();
        if ($queued === 0) {
            return null;
        }

        return response()->json([
            'message' => "{$queued} conversion(s) are still queued for this {$scope->noun()} — "
                . 'wait for them to run before reconverting it again.',
            'pending' => $queued,
        ], 409);
    }

    /**
     * Record a run and hand it to the worker.
     *
     * @param array<string, mixed> $extra columns only one console sets (the journal's work limit
     *                                    and chain fields)
     */
    private function startRun(
        ImportConsoleScope $scope,
        Request $request,
        string $action,
        string $lanes,
        ?string $canonicalId,
        ?string $book,
        array $extra = [],
    ): JsonResponse {
        $runId = (string) Str::uuid();
        DB::connection('pgsql_admin')->table('journal_import_runs')->insert(array_merge([
            'id'                  => $runId,
            $scope->runColumn()   => $scope->id,
            'canonical_source_id' => $canonicalId,
            'user_id'             => $request->user()?->id,
            'action'              => $action,
            'lanes'               => $lanes,
            'status'              => 'pending',
            'book'                => $book,
            'counts'              => '{}',
            'created_at'          => now(),
            'updated_at'          => now(),
        ], $extra));

        JournalImportActionJob::dispatch($runId);

        return response()->json(['run_id' => $runId, 'already_running' => false]);
    }

    /**
     * Fold canonical×library rows into an articles list with lanes nested.
     * Rows must carry the column set both consoles select (canonical_id,
     * title…, plus the lane's library columns). Lanes with no book or a
     * deleted row are skipped.
     *
     * @param iterable<object> $rows
     * @param array<string, array{count?:int, note?:?string}> $flagged
     * @return array<int, array<string, mixed>>
     */
    private function foldArticles(iterable $rows, array $flagged, ReconvertQueue $queue): array
    {
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

            // Regression-suite state for the "✓ golden" step: add_fixture.py seeds
            // only golden/{references,audit}.json — nodes.summary.json exists only
            // after a run_regression.py --update-golden, so it marks a frozen golden.
            $fixtureTree = $queue->fixtureTreeFor($r->book);

            $articles[$r->canonical_id]['lanes'][] = [
                'book'              => $r->book,
                'lane'              => $this->laneLabel($r->foundation_source, $r->conversion_method),
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
                'fixture'           => $fixtureTree,
                'golden_complete'   => $fixtureTree !== null
                    && is_file(base_path("tests/conversion/{$fixtureTree}/{$r->book}/golden/nodes.summary.json")),
                'open_flags'        => $flagged[$r->book]['count'] ?? 0,
                'maintainer_note'   => $flagged[$r->book]['note'] ?? null,
                'metadata_drift'    => $flagged[$r->book]['metadata_drift'] ?? null,
                'artifacts'         => $queue->artifactsFor($r->book),
                'fetch_trace'       => $this->fetchTrace($r->book),
                'created_at'        => $r->lane_created_at,
            ];
        }

        return array_values($articles);
    }

    /**
     * Display label for a lane. Identity is foundation_source (which pipeline minted the
     * row), but the vacuum lane runs the whole ContentFetchService ladder, so a row it
     * minted may hold JATS XML (strategy 0) or a browser-fetched page (strategy 5) rather
     * than an OCR'd PDF — labelling those 'pdf' lies about what's in the row. Name the
     * lane by what the ladder actually won with. Display-safe: FE logic keys only on
     * 'html' (the journal_html sibling), never on 'pdf'.
     */
    private function laneLabel(?string $foundationSource, ?string $conversionMethod): string
    {
        $label = self::$laneLabels[$foundationSource] ?? ($foundationSource ?: 'other');
        if ($label === 'pdf') {
            return match ($conversionMethod) {
                'jats_fulltext'      => 'jats',
                'paste_engine_html'  => 'web',
                default              => $label,
            };
        }

        return $label;
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
        foreach (DB::table('conversion_flags')->where('status', 'open')->get(['book', 'source', 'details']) as $flag) {
            $details = is_array($flag->details) ? $flag->details : (json_decode((string) $flag->details, true) ?: []);
            $out[$flag->book]['count'] = ($out[$flag->book]['count'] ?? 0) + 1;
            $out[$flag->book]['note'] ??= $details['maintainer_note'] ?? null;

            // A metadata flag is a different KIND of problem from the rest: the conversion is
            // fine, a citation field is wrong. Carry its field-by-field diff so the console can
            // show stored-vs-page and let the maintainer settle it on sight, instead of showing
            // a flag count that implies the text needs re-converting.
            if ($flag->source === ConversionFlag::SOURCE_METADATA_DRIFT) {
                $out[$flag->book]['metadata_drift'] = [
                    // "You must choose" versus "here is what was changed for you" — same flag
                    // kind, very different call to action.
                    'needs_decision' => (bool) ($details['needs_decision'] ?? true),
                    'fields'         => $details['fields'] ?? [],
                    'applied'        => $details['applied'] ?? [],
                ];
            }
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
