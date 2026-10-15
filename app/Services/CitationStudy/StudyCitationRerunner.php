<?php

namespace App\Services\CitationStudy;

use App\Services\BillingService;
use Carbon\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use RuntimeException;
use Symfony\Component\Process\Exception\ProcessTimedOutException;
use Symfony\Component\Process\Process;

/**
 * Re-runs ONE citation (extraction → resolution ladder → review) and patches
 * the fresh claim rows into a NEW run dir, so a pipeline-stage fix can be
 * verified in the workbench without re-billing the whole book.
 *
 * The patched run is a SUB-VERSION of its base: run_id {root}.{N} (e.g.
 * 20260925_233337_b55ce8dd.1), where root is the base run_id stripped of any
 * existing .N — so a patch of a patch becomes .2 of the same root, and the
 * dotted name sorts next to its base and reads as a derivative everywhere
 * run_ids are shown. Past runs stay immutable; provenance.json records the
 * immediate base and the patch's own git revision.
 *
 * What it deliberately CANNOT do: run after a reimport. A reconvert reissues
 * every footnoteId (ms timestamps) and rebinding rewrites bound_reference_id
 * for ALL entries, so every base-claims row's refId goes stale at once —
 * patching one citation into that file is incoherent. The unit of re-run
 * after a reconvert is the whole book.
 */
class StudyCitationRerunner
{
    public function __construct(
        private readonly StudyBookImporter $importer,
        private readonly ProvenanceRecorder $provenance,
        private readonly StudyRunner $runner,
        private readonly ClaimsPatcher $patcher,
    ) {}

    /**
     * @param string $citation a gt_id (c04) or a referenceId (optionally ref:-prefixed)
     * @param callable(string): void $say progress line callback
     */
    public function rerun(CorpusManifest $manifest, string $slug, string $citation, bool $dryRun, callable $say): array
    {
        $fullBookCmd = "php artisan citation:study:run {$manifest->corpus} --book={$slug} --force-rerun";

        if ($manifest->isFrozen()) {
            throw new RuntimeException(
                "Corpus '{$manifest->corpus}' is frozen — a patched run mixes code versions and cannot back "
                . "reported numbers. Unfreeze, or re-run the whole book: {$fullBookCmd}"
            );
        }

        $book = $manifest->book($slug);
        $bookId = $manifest->bookIdFor($slug);
        $db = DB::connection('pgsql_admin');

        if (!$this->importer->exists($bookId)) {
            throw new RuntimeException("{$bookId} not imported — run citation:study:import first.");
        }
        $this->importer->assertNoCanonicalIdentifiers($bookId);

        $groundTruth = $manifest->loadGroundTruth($book);
        if (empty($groundTruth['binding']['bound_at'])) {
            throw new RuntimeException("{$slug}: ground truth not bound — run citation:study:import first.");
        }

        [$referenceId, $gtIds] = $this->resolveCitation($groundTruth, $citation, $slug);

        // The refId must exist LIVE — same dual lookup the scan command does.
        $live = $db->table('bibliography')->where('book', $bookId)->where('referenceId', $referenceId)->exists()
            || $db->table('footnotes')->where('book', $bookId)->where('footnoteId', $referenceId)->exists();
        if (!$live) {
            throw new RuntimeException(
                "{$referenceId} not found in {$bookId}'s bibliography or footnotes — the book was likely "
                . "re-imported since that id was minted. Re-run the whole book: {$fullBookCmd}"
            );
        }

        // Base run: a completed record with a readable claims file.
        $state = $this->runner->loadState($manifest);
        $base = $state['books'][$slug] ?? null;
        if (($base['status'] ?? null) !== 'completed' || empty($base['claims_file']) || !is_file($base['claims_file'])) {
            throw new RuntimeException(
                "No completed base run for {$slug} — a patch needs a run to patch. Run: {$fullBookCmd}"
            );
        }
        $baseRunId = (string) $base['run_id'];

        // Reimport drift: a rebind newer than the base run means EVERY row's
        // refId in the base claims file is stale, not just this one's.
        $boundAt = Carbon::parse($groundTruth['binding']['bound_at']);
        $baseStartedAt = isset($base['started_at']) ? Carbon::parse($base['started_at']) : null;
        if ($baseStartedAt !== null && $boundAt->greaterThan($baseStartedAt)) {
            throw new RuntimeException(
                "{$slug} was re-imported/re-bound after the base run ({$baseRunId}) — every claims row's "
                . "referenceId is stale, so single-citation patching is incoherent. Re-run the whole book: {$fullBookCmd}"
            );
        }

        $baseClaims = json_decode((string) file_get_contents($base['claims_file']), true);
        if (!is_array($baseClaims)) {
            throw new RuntimeException("Base claims file unreadable: {$base['claims_file']}");
        }
        $this->assertBaseRefsLive($db, $bookId, $baseClaims, $baseRunId, $fullBookCmd);

        $user = $this->importer->studyUser();
        if (!app(BillingService::class)->canProceed($user)) {
            throw new RuntimeException(
                "Study user '{$user->name}' has no balance — billReview() is try/caught, so running broke "
                . 'silently loses the per-run cost data. Top up first.'
            );
        }

        $runId = $this->mintPatchRunId($manifest, $state, $slug, $baseRunId);
        $runDir = $manifest->resultsDir() . "/runs/{$runId}";

        if ($dryRun) {
            return [
                'dry_run' => true,
                'run_id' => $runId,
                'base_run' => $baseRunId,
                'reference_id' => $referenceId,
                'gt_ids' => $gtIds,
            ];
        }

        // Settle any stale pending/running pipeline rows for THIS book (same
        // reasoning as the study runner's preflight, scoped to one book).
        $stale = $db->table('citation_pipelines')
            ->where('book', $bookId)->whereIn('status', ['pending', 'running'])->get(['id']);
        foreach ($stale as $row) {
            $this->runner->settlePipelineRow($row->id, 'Auto-failed by citation:study:rerun preflight (stale row)');
            $say("settled stale pipeline row {$row->id}");
        }

        $snapshot = $this->provenance->snapshot($manifest);

        // Mint the pipeline row — without it the pipeline records zero step
        // timings, and the patch's fetch/OCR costs would be unbillable.
        $pipelineId = (string) Str::uuid();
        $db->table('citation_pipelines')->insert([
            'id' => $pipelineId,
            'book' => $bookId,
            'user_id' => $user->id,
            'status' => 'pending',
            'inference_mode' => 'server',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $say("rerun {$slug}:{$referenceId} (gt: " . ($gtIds ? implode(', ', $gtIds) : 'none') . ") as {$runId}");

        $before = glob(storage_path("app/citation-review-partial_{$bookId}_*.json")) ?: [];

        ['exit' => $exit, 'output' => $output] = $this->runTargetedPipeline($bookId, $referenceId, $pipelineId, $user->id);

        @mkdir($runDir, 0775, true);
        $logPath = "{$runDir}/{$slug}.log";
        file_put_contents($logPath, $output);

        $after = glob(storage_path("app/citation-review-partial_{$bookId}_*.json")) ?: [];
        $new = array_values(array_diff($after, $before));
        sort($new);
        $partialFile = $new !== [] ? end($new) : null;
        $freshClaims = $partialFile ? json_decode((string) file_get_contents($partialFile), true) : null;

        if ($exit !== 0 || !is_array($freshClaims) || $freshClaims === []) {
            $this->runner->settlePipelineRow($pipelineId, 'Single-citation rerun produced no claims');
            throw new RuntimeException(
                "single-citation review produced no claims for {$referenceId} — base run left untouched "
                . "(see {$logPath}). If the citation legitimately no longer yields a claim, do a full "
                . "--book re-run: {$fullBookCmd}"
            );
        }

        // Merge and write the patched run.
        $merged = $this->patcher->patch($baseClaims, $freshClaims, $referenceId);
        $claimsPath = "{$runDir}/{$slug}.claims.json";
        file_put_contents($claimsPath, json_encode($merged['claims'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");

        // Coverage is a statement about the whole-book parse, which this patch
        // does not change — inherit the base run's, visibly.
        $baseCoverage = dirname($base['claims_file']) . "/{$slug}.coverage.json";
        if (is_file($baseCoverage)) {
            $coverage = json_decode((string) file_get_contents($baseCoverage), true) ?: [];
            $coverage['inherited_from_run'] = $baseRunId;
            file_put_contents("{$runDir}/{$slug}.coverage.json", json_encode($coverage, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
        }

        $contamination = $this->runner->contaminationAudit($claimsPath, $groundTruth);
        foreach ($contamination as $flag) {
            $say("CONTAMINATION {$slug}: {$flag}");
        }

        $snapshot['patched'] = [
            'base_run' => $baseRunId,
            'slug' => $slug,
            'reference_id' => $referenceId,
            'gt_ids' => $gtIds,
            'replaced_rows' => $merged['replaced'],
            'fresh_rows' => $merged['inserted'],
            'patch_pipeline_id' => $pipelineId,
            'coverage' => 'inherited from base run',
        ];
        $this->provenance->write($runDir, $snapshot);

        // Settle the patch pipeline row (direct CLI runs bypass the queue-job
        // wrapper that normally completes it).
        $db->table('citation_pipelines')->where('id', $pipelineId)
            ->whereIn('status', ['pending', 'running'])
            ->update(['status' => 'completed', 'updated_at' => now()]);

        // Repoint state.json. pipeline_id stays the BASE run's on purpose:
        // ClaimsJoiner::bookMeta derives book_cost_usd and step timings from
        // it, and those columns should keep describing the bulk run — the
        // patch's own costs live under the patch sub-key.
        $history = $this->runner->archiveIntoHistory($base, $runId);
        $state['books'][$slug] = array_merge($base, [
            'run_id' => $runId,
            'status' => 'completed',
            'started_at' => now()->toIso8601String(),
            'finished_at' => now()->toIso8601String(),
            'claims_file' => $claimsPath,
            'claims_file_source' => $partialFile,
            'log' => $logPath,
            'contamination' => $contamination,
            'history' => $history,
            'patch' => [
                'base_run_id' => $baseRunId,
                'reference_id' => $referenceId,
                'gt_ids' => $gtIds,
                'patch_pipeline_id' => $pipelineId,
            ],
        ]);
        $this->runner->saveState($manifest, $state);

        return [
            'run_id' => $runId,
            'run_dir' => $runDir,
            'base_run' => $baseRunId,
            'reference_id' => $referenceId,
            'gt_ids' => $gtIds,
            'replaced' => $merged['replaced'],
            'inserted' => $merged['inserted'],
            'contamination' => $contamination,
            'claims_file' => $claimsPath,
        ];
    }

    /**
     * One child php process, same isolation reasoning as StudyRunner::runBook.
     * Protected so tests can fabricate the partial file instead of spawning a
     * real pipeline.
     *
     * @return array{exit: int, output: string}
     */
    protected function runTargetedPipeline(string $bookId, string $referenceId, string $pipelineId, int $userId): array
    {
        $process = new Process([
            PHP_BINARY,
            '-d', 'memory_limit=' . config('study.memory_limit', '2G'),
            'artisan', 'citation:pipeline', $bookId,
            "--only={$referenceId}",
            "--pipeline-id={$pipelineId}",
            "--user-id={$userId}",
            '--force',
        ], base_path());
        $process->setTimeout((int) config('study.book_timeout_seconds', 6 * 3600));
        try {
            $process->run();
            $exit = $process->getExitCode() ?? 1;
        } catch (ProcessTimedOutException) {
            $exit = 124;
        }

        return ['exit' => $exit, 'output' => $process->getOutput() . $process->getErrorOutput()];
    }

    /**
     * Resolve the citation argument: a gt_id maps through its entry's
     * bound_reference_id; anything else is taken as a raw referenceId
     * (ref:-prefix tolerated — the workbench shows unjoined rows that way).
     * Stored gt_ids are slug-prefixed ("deloitte-2025-pdf/c04"), so the bare
     * "c04" the workbench displays is accepted too, and a multi-work row's
     * "::subN" suffix is stripped — the unit of re-run is the whole footnote
     * (the sub re-enters the pool through its parent's sub_citations).
     * Returns [referenceId, all gt_ids bound to it] — snippet-level entries
     * share one bound_reference_id, and the patch unit is the referenceId.
     */
    private function resolveCitation(array $groundTruth, string $citation, string $slug): array
    {
        $citation = preg_replace('/::sub\d+$/', '', $citation);
        $accepted = [$citation, "{$slug}/{$citation}"];
        $referenceId = null;
        foreach ($groundTruth['entries'] as $entry) {
            if (in_array($entry['gt_id'] ?? null, $accepted, true)) {
                $referenceId = $entry['bound_reference_id'] ?? null;
                if ($referenceId === null || $referenceId === '') {
                    throw new RuntimeException(
                        "gt {$citation} is not bound to a reference — it cannot be re-run in isolation."
                    );
                }
                break;
            }
        }
        $referenceId ??= preg_replace('/^ref:/', '', $citation);

        $gtIds = [];
        foreach ($groundTruth['entries'] as $entry) {
            if (($entry['bound_reference_id'] ?? null) === $referenceId && !empty($entry['gt_id'])) {
                $gtIds[] = $entry['gt_id'];
            }
        }

        return [$referenceId, $gtIds];
    }

    /**
     * Belt-and-braces reimport detector: every distinct parent refId in the
     * base claims file must still exist live. One stale id means the file
     * predates a reconvert the bound_at timestamp did not catch.
     */
    private function assertBaseRefsLive($db, string $bookId, array $baseClaims, string $baseRunId, string $fullBookCmd): void
    {
        $parents = [];
        foreach ($baseClaims as $row) {
            $refId = $row['referenceId'] ?? null;
            if (is_string($refId) && $refId !== '') {
                $parents[explode('::', $refId, 2)[0]] = true;
            }
        }
        $parents = array_keys($parents);
        if ($parents === []) {
            return;
        }

        $liveBib = $db->table('bibliography')->where('book', $bookId)
            ->whereIn('referenceId', $parents)->pluck('referenceId')->all();
        $liveFn = $db->table('footnotes')->where('book', $bookId)
            ->whereIn('footnoteId', $parents)->pluck('footnoteId')->all();
        $stale = array_values(array_diff($parents, $liveBib, $liveFn));

        if ($stale !== []) {
            $sample = implode(', ', array_slice($stale, 0, 3));
            throw new RuntimeException(
                count($stale) . " base-claims referenceId(s) no longer exist in {$bookId} (e.g. {$sample}) — "
                . "the book was re-imported since the base run ({$baseRunId}), so single-citation patching is "
                . "incoherent. Re-run the whole book: {$fullBookCmd}"
            );
        }
    }

    /**
     * {root}.{N}: root = base run_id without any .N suffix; N = one past the
     * highest existing sub-version, counted across BOTH runs/ dirs and the
     * state history (a crashed patch can leave a dir with no state record,
     * and a superseded one the reverse).
     */
    private function mintPatchRunId(CorpusManifest $manifest, array $state, string $slug, string $baseRunId): string
    {
        $root = preg_replace('/\.\d+$/', '', $baseRunId);

        $max = 0;
        foreach (glob($manifest->resultsDir() . "/runs/{$root}.*") ?: [] as $dir) {
            if (preg_match('/\.(\d+)$/', basename($dir), $m)) {
                $max = max($max, (int) $m[1]);
            }
        }
        $records = array_merge(
            [$state['books'][$slug] ?? []],
            $state['books'][$slug]['history'] ?? [],
        );
        foreach ($records as $record) {
            $rid = $record['run_id'] ?? '';
            if (is_string($rid) && str_starts_with($rid, "{$root}.") && preg_match('/\.(\d+)$/', $rid, $m)) {
                $max = max($max, (int) $m[1]);
            }
        }

        return $root . '.' . ($max + 1);
    }
}
