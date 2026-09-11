<?php

namespace App\Services\CitationStudy;

use App\Services\BillingService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use RuntimeException;
use Symfony\Component\Process\Exception\ProcessTimedOutException;
use Symfony\Component\Process\Process;

/**
 * Runs the full citation pipeline over a corpus, one book at a time, with the
 * bookkeeping a scientific run needs: minted pipeline rows (else no timings or
 * telemetry get recorded), exact claims-file capture, crash-resumable state,
 * and a post-run contamination audit. Every run passes --force so the 24h
 * no-match cooldown can never leak cached verdicts between runs.
 */
class StudyRunner
{
    public function __construct(
        private readonly StudyBookImporter $importer,
        private readonly ProvenanceRecorder $provenance,
        private readonly CorpusLock $lock,
    ) {}

    /**
     * @param callable(string): void $say progress line callback
     */
    public function run(
        CorpusManifest $manifest,
        ?string $onlySlug,
        bool $forceRerun,
        bool $dryRun,
        callable $say,
    ): array {
        $user = $this->importer->studyUser();
        $this->preflight($manifest, $user, $say);

        $resultsDir = $manifest->resultsDir();
        @mkdir($resultsDir, 0775, true);
        $state = $this->loadState($manifest);

        $snapshot = $this->provenance->snapshot($manifest);
        $runId = now()->format('Ymd_His') . '_' . substr($snapshot['git_rev'] ?? 'nogit', 0, 8);
        $runDir = "{$resultsDir}/runs/{$runId}";

        $books = $onlySlug !== null
            ? [$manifest->book($onlySlug)]
            : $manifest->books();

        $planned = [];
        foreach ($books as $book) {
            $slug = $book['slug'];
            if (!$forceRerun && ($state['books'][$slug]['status'] ?? null) === 'completed') {
                $say("skip {$slug} (already completed; --force-rerun to redo)");
                continue;
            }
            $planned[] = $book;
        }

        if ($dryRun) {
            return [
                'run_id' => $runId,
                'dry_run' => true,
                'planned' => array_map(fn ($b) => $b['slug'], $planned),
            ];
        }
        if ($planned === []) {
            return ['run_id' => $runId, 'planned' => [], 'message' => 'Nothing to run.'];
        }

        $this->provenance->write($runDir, $snapshot);
        $throttle = (int) config('study.throttle_seconds', 5);

        foreach ($planned as $i => $book) {
            $slug = $book['slug'];
            $bookId = $manifest->bookIdFor($slug);
            if ($i > 0 && $throttle > 0) {
                sleep($throttle);
            }
            $say("run {$slug} ({$bookId})");

            // A re-run (the warm-commons counterfactual) must not orphan the
            // previous run's data — archive the old record into history so
            // citation:study:report --run=<old> can still join it.
            $previous = $state['books'][$slug] ?? null;
            $history = $previous['history'] ?? [];
            if ($previous !== null && ($previous['run_id'] ?? null) !== $runId && ($previous['status'] ?? null) === 'completed') {
                $archived = $previous;
                unset($archived['history']);
                $history[] = $archived;
            }

            $record = [
                'book_id' => $bookId,
                'run_id' => $runId,
                'status' => 'running',
                'started_at' => now()->toIso8601String(),
                'history' => $history,
            ];
            $state['books'][$slug] = array_merge($previous ?? [], $record);
            $this->saveState($manifest, $state);

            try {
                $result = $this->runBook($manifest, $book, $user->id, $runDir, $say);
                $state['books'][$slug] = array_merge($state['books'][$slug], $result, [
                    'status' => $result['claims_file'] ? 'completed' : 'failed',
                    'finished_at' => now()->toIso8601String(),
                ]);
            } catch (\Throwable $e) {
                $say("FAILED {$slug}: {$e->getMessage()}");
                $state['books'][$slug] = array_merge($state['books'][$slug], [
                    'status' => 'failed',
                    'error' => $e->getMessage(),
                    'finished_at' => now()->toIso8601String(),
                ]);
                $this->settlePipelineRow($state['books'][$slug]['pipeline_id'] ?? null, $e->getMessage());
            }
            $this->saveState($manifest, $state);
        }

        return [
            'run_id' => $runId,
            'run_dir' => $runDir,
            'planned' => array_map(fn ($b) => $b['slug'], $planned),
            'state' => $state,
        ];
    }

    private function runBook(CorpusManifest $manifest, array $book, int $userId, string $runDir, callable $say): array
    {
        $slug = $book['slug'];
        $bookId = $manifest->bookIdFor($slug);
        $db = DB::connection('pgsql_admin');

        if (!$this->importer->exists($bookId)) {
            throw new RuntimeException("{$bookId} not imported — run citation:study:import first.");
        }
        $groundTruth = $manifest->loadGroundTruth($book);
        if (empty($groundTruth['binding']['bound_at'])) {
            throw new RuntimeException("{$slug}: ground truth not bound — run citation:study:import first.");
        }

        // Mint the pipeline row ourselves — without it the pipeline records
        // zero step timings and zero telemetry (bare CLI runs are blind).
        $pipelineId = (string) Str::uuid();
        $db->table('citation_pipelines')->insert([
            'id' => $pipelineId,
            'book' => $bookId,
            'user_id' => $userId,
            'status' => 'pending',
            'inference_mode' => 'server',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $before = glob(storage_path("app/citation-review_{$bookId}_*.json")) ?: [];

        // Each book runs in its OWN php process: a fatal (the 512MB OOM in
        // pdfparser on a big fetched source) then kills one book, not the
        // whole multi-hour run — and the study can raise the memory ceiling
        // without touching global php.ini.
        $process = new Process([
            PHP_BINARY,
            '-d', 'memory_limit=' . config('study.memory_limit', '2G'),
            'artisan', 'citation:pipeline', $bookId,
            "--pipeline-id={$pipelineId}",
            "--user-id={$userId}",
            '--force',
        ], base_path());
        $process->setTimeout((int) config('study.book_timeout_seconds', 6 * 3600));
        try {
            $process->run();
            $exit = $process->getExitCode() ?? 1;
        } catch (ProcessTimedOutException $e) {
            $exit = 124;
        }

        @mkdir($runDir, 0775, true);
        file_put_contents("{$runDir}/{$slug}.log", $process->getOutput() . $process->getErrorOutput());

        // Exact-capture the claims file this run produced. Exit code alone is
        // not trustworthy (citation:review exits 0 on empty results by design).
        $after = glob(storage_path("app/citation-review_{$bookId}_*.json")) ?: [];
        $new = array_values(array_diff($after, $before));
        sort($new);
        $claimsFile = $new !== [] ? end($new) : null;

        $copiedClaims = null;
        $contamination = [];
        if ($claimsFile) {
            $copiedClaims = "{$runDir}/{$slug}.claims.json";
            copy($claimsFile, $copiedClaims);
            $mdTwin = preg_replace('/\.json$/', '.md', $claimsFile);
            if (is_file($mdTwin)) {
                copy($mdTwin, "{$runDir}/{$slug}.report.md");
            }
            $contamination = $this->contaminationAudit($copiedClaims, $groundTruth);
            foreach ($contamination as $flag) {
                $say("  CONTAMINATION {$slug}: {$flag}");
            }
        }

        $pipeline = $db->table('citation_pipelines')->where('id', $pipelineId)->first();

        // The pipeline command settles its own row through the HTTP job path,
        // but not when driven via Artisan::call — leave failed rows visible,
        // settle a still-pending/running row by outcome.
        if ($pipeline && in_array($pipeline->status, ['pending', 'running'], true)) {
            $db->table('citation_pipelines')->where('id', $pipelineId)->update([
                'status' => $claimsFile ? 'completed' : 'failed',
                'error' => $claimsFile ? null : 'Study run produced no claims file',
                'updated_at' => now(),
            ]);
        }

        if ($exit !== 0) {
            throw new RuntimeException("citation:pipeline exited {$exit} (see {$runDir}/{$slug}.log)");
        }

        return [
            'pipeline_id' => $pipelineId,
            'exit_code' => $exit,
            'claims_file' => $copiedClaims,
            'claims_file_source' => $claimsFile,
            'log' => "{$runDir}/{$slug}.log",
            'pipeline_status' => $db->table('citation_pipelines')->where('id', $pipelineId)->value('status'),
            'contamination' => $contamination,
        ];
    }

    /** @return string[] contamination flags (empty = clean) */
    public function contaminationAudit(string $claimsPath, array $groundTruth): array
    {
        $claims = json_decode((string) file_get_contents($claimsPath), true) ?: [];
        $flags = [];

        $fabricatedRefs = [];
        foreach ($groundTruth['entries'] as $entry) {
            if ($entry['label'] === 'fabricated_reference' && !empty($entry['bound_reference_id'])) {
                $fabricatedRefs[] = $entry['bound_reference_id'];
            }
        }

        foreach ($claims as $claim) {
            $sourceBook = $claim['source_book_id'] ?? null;
            if (is_string($sourceBook) && str_starts_with($sourceBook, 'study_')) {
                $flags[] = "claim {$claim['referenceId']} resolved against study book {$sourceBook}";
            }
            if (in_array($claim['referenceId'] ?? null, $fabricatedRefs, true)
                && !empty($claim['verified_source'])
            ) {
                $flags[] = "fabricated reference {$claim['referenceId']} resolved to a source"
                    . ' (' . ($claim['source_title'] ?? 'unknown') . ') — fake collided with a real work';
            }
        }
        return array_values(array_unique($flags));
    }

    private function preflight(CorpusManifest $manifest, \App\Models\User $user, callable $say): void
    {
        if ($manifest->isFrozen()) {
            $this->lock->assertClean($manifest);
            $say('frozen corpus verified against corpus.lock.json');
        }

        if (!app(BillingService::class)->canProceed($user)) {
            throw new RuntimeException(
                "Study user '{$user->name}' has no balance — billReview() is try/caught, so running broke "
                . 'silently loses the per-run cost data. Top up first.'
            );
        }

        $db = DB::connection('pgsql_admin');

        foreach ($manifest->books() as $book) {
            $bookId = $manifest->bookIdFor($book['slug']);
            if ($this->importer->exists($bookId)) {
                $this->importer->assertNoCanonicalIdentifiers($bookId);
            }
        }

        // A stuck pending/running pipeline row blocks nothing at CLI level but
        // poisons step-timing reads — settle stale ones before starting.
        $stale = $db->table('citation_pipelines')
            ->where('book', 'like', 'study\_' . str_replace('_', '\_', $manifest->corpus) . '\_%')
            ->whereIn('status', ['pending', 'running'])
            ->get(['id', 'book']);
        foreach ($stale as $row) {
            $db->table('citation_pipelines')->where('id', $row->id)->update([
                'status' => 'failed',
                'error' => 'Auto-failed by citation:study:run preflight (stale row from an interrupted run)',
                'updated_at' => now(),
            ]);
            $say("settled stale pipeline row {$row->id} ({$row->book})");
        }
    }

    private function settlePipelineRow(?string $pipelineId, string $error): void
    {
        if (!$pipelineId) {
            return;
        }
        DB::connection('pgsql_admin')
            ->table('citation_pipelines')
            ->where('id', $pipelineId)
            ->whereIn('status', ['pending', 'running'])
            ->update(['status' => 'failed', 'error' => $error, 'updated_at' => now()]);
    }

    public function loadState(CorpusManifest $manifest): array
    {
        $path = $manifest->resultsDir() . '/state.json';
        if (!is_file($path)) {
            return ['corpus' => $manifest->corpus, 'books' => []];
        }
        $state = json_decode((string) file_get_contents($path), true);
        return is_array($state) ? $state : ['corpus' => $manifest->corpus, 'books' => []];
    }

    private function saveState(CorpusManifest $manifest, array $state): void
    {
        $path = $manifest->resultsDir() . '/state.json';
        @mkdir(dirname($path), 0775, true);
        file_put_contents($path, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    }
}
