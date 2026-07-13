<?php

namespace App\Jobs;

use App\Mail\VibeOutcomeMail;
use App\Services\ConversionArtifactSaver;
use App\Services\VibePatchApplier;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Symfony\Component\Process\Process;

/**
 * Background "✨ Vibe convert" — runs the bounded retry loop on the queue worker so the user
 * can close the toast and (optionally) be emailed when done. Writes vibe_progress.json (the
 * toast polls it), honours vibe_cancel (the Cancel button), opens a GitHub issue on an unfixed
 * run, and emails fml@hyperlit.io (and the user, if requested). FREE — never billed (see the
 * outcome block in handle(): experimental dead end, charging removed 2026-07-12).
 *
 * The patch is applied ONLY in a throwaway sandbox during the loop — production code is never
 * touched. "Use this conversion" (the accept step) is a separate explicit action.
 *
 * Engine: app/Python/vibe_convert.py · Controller: app/Http/Controllers/VibeConvertController.php
 * DB swap: app/Services/ConversionArtifactSaver.php · Email: app/Mail/VibeOutcomeMail.php
 * Full docs (how the loop, the 3-tier gate, the GitHub issue + prod/security work):
 *   → tests/conversion/README.md  (§6 "Vibe conversion")
 */
class VibeConversionJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 1800; // 30 min — up to 3 reasoning-model attempts × full re-conversion
    public int $tries = 1;      // never auto-retry — it's expensive + the loop is its own retry

    public function __construct(
        private string $bookId,
        private ?int $userId = null,
        private ?string $note = null,
        private array $issueTypes = [],
    ) {
        // OWN queue — a vibe conversion shells out to Python for up to ~28 min (Process timeout 1700s),
        // so it must NOT share the `default` queue with imports: a single serial worker would let one
        // vibe run head-of-line-block every user's import. A DEDICATED `vibe` worker runs it in parallel
        // (mirrors GenerateNodeEmbedding→'embeddings' / the citation jobs→'citation-pipeline'). REQUIRES a
        // worker listening on `vibe` (Supervisor hyperlit-vibe.conf / `npm run queue:vibe`) or it never runs.
        $this->onQueue('vibe');
    }

    public function handle(): void
    {
        $dir = resource_path("markdown/{$this->bookId}");
        if (!is_dir($dir) || !file_exists("{$dir}/assessment.json")) {
            Log::warning('VibeConversionJob: no conversion artifacts', ['book' => $this->bookId]);
            $this->releaseConvertLock();   // free the start() lock so a retry can run
            return;
        }

        $progress = "{$dir}/vibe_progress.json";
        $cancel = "{$dir}/vibe_cancel";
        $useNow = "{$dir}/vibe_use_now";
        @unlink($progress);  // fresh run
        @unlink($cancel);
        @unlink($useNow);

        $cmd = [
            env('PYTHON_PATH', 'python3'), base_path('app/Python/vibe_convert.py'), $dir,
            '--max-attempts', '3', '--github',
            '--progress-file', $progress, '--cancel-file', $cancel, '--use-now-file', $useNow,
        ];
        if ($this->note) {
            $cmd[] = '--user-note';
            $cmd[] = $this->note;
        }
        if ($this->issueTypes) {
            $cmd[] = '--issue-types';
            $cmd[] = json_encode(array_values($this->issueTypes));
        }
        // Edit-gen engine (a MECHANISM, not a model — it runs whatever model the script picks):
        // 'native' (our full-function-JSON loop, default) or 'aider' (repo-map + search/replace +
        // test-driven retry). aider runs on the HOST and needs VIBE_AIDER_BIN (a venv's aider) — the
        // gate's reconvert still runs in the container (below).
        $procEnv = null;
        // Default to the NATIVE engine (deepseek-v4-pro): it produces the structured edits this needs.
        // aider was tried but a heavy reasoning model overflows its reflection loop (context blow-out);
        // aider stays available via VIBE_ENGINE=aider (best paired with a FAST model like gpt-oss-120b).
        if (env('VIBE_ENGINE', 'native') === 'aider') {
            $cmd[] = '--engine';
            $cmd[] = 'aider';
            if ($aiderBin = env('VIBE_AIDER_BIN')) {
                $procEnv = ['VIBE_AIDER_BIN' => $aiderBin];
            }
        }
        // PROD: run the model-written re-conversion inside a locked-down container. Set
        // VIBE_SANDBOX_IMAGE in .env (after `docker build -t … docker/vibe-sandbox`) to enable it.
        if ($image = env('VIBE_SANDBOX_IMAGE')) {
            $cmd[] = '--docker';
            $cmd[] = $image;
        }

        $process = new Process($cmd, base_path(), $procEnv, null, 1700);
        try {
            $process->run();
        } catch (\Throwable $e) {
            Log::error('VibeConversionJob: process failed', ['book' => $this->bookId, 'err' => $e->getMessage()]);
        }

        $report = null;
        $reportPath = "{$dir}/vibe_report.json";
        if (is_file($reportPath)) {
            $report = json_decode(File::get($reportPath), true);
        }

        // FREE — deliberately unbilled. Vibe convert is an experimental dead end
        // (it rarely produces a fix); charging for it was removed 2026-07-12.
        // The canProceed() gate in VibeConvertController stays (it still costs
        // hyperlit real LLM money, so zero-balance accounts can't spam it). If
        // it ever earns its keep, restore a charge() here keyed on $outcome.
        $outcome = $report['outcome'] ?? 'unknown';

        // AUTO-APPLY a clean/improved fix to the LIVE book, then leave a review marker so the reader can
        // surface a Keep/Revert toast (on the success poll OR on any later book load). The original
        // conversion is archived by the nodes_versioning_trigger; "Revert" restores it to $restoreTs.
        if (in_array($outcome, ['clean', 'improved'], true)) {
            // Make sure the ORIGINAL conversion is in the DB so the apply ARCHIVES it (→ revert target).
            // Imports only populate the `nodes` table on edit/sync, so a freshly-imported book can have
            // zero PG nodes; load the current artifacts first IFF empty (never clobber a user's edits).
            try {
                if (DB::table('nodes')->where('book', $this->bookId)->count() === 0) {
                    app(ConversionArtifactSaver::class)->saveAll($dir, $this->bookId);
                }
            } catch (\Throwable $e) {
                Log::warning('VibeConversionJob: pre-apply original load failed',
                    ['book' => $this->bookId, 'err' => $e->getMessage()]);
            }
            // Capture the restore point BEFORE applying — the live nodes are still active at this instant,
            // so restoring here gets the original back once the apply archives them.
            $restoreTs = now()->utc()->format('Y-m-d\TH:i:s.uP');   // timestamptz-compatible
            // PIN the first pre-vibe restore point so "Revert to original" ALWAYS returns to the pre-vibe
            // conversion, however many feedback rounds (Give feedback & re-try) get applied on top. The
            // FIRST apply writes vibe_origin.json; every later round reuses it (the apply on round 2 would
            // otherwise pin the round-1 version as "original"). It's cleared only by an explicit Revert.
            $originPath = "{$dir}/vibe_origin.json";
            if (is_file($originPath)) {
                $origin = json_decode(File::get($originPath), true);
                if (is_array($origin) && !empty($origin['restore_ts'])) {
                    $restoreTs = $origin['restore_ts'];
                }
            } else {
                File::put($originPath, json_encode(['restore_ts' => $restoreTs,
                    'created_at' => now()->toIso8601String()], JSON_PRETTY_PRINT));
            }
            $applied = app(VibePatchApplier::class)->apply($this->bookId);
            if ($applied['success']) {
                $beat = $this->lastSuccessBeat($dir);
                File::put("{$dir}/vibe_review.json", json_encode([
                    'status' => 'pending',
                    'tier' => $beat['tier'] ?? $outcome,
                    'before' => $beat['before'] ?? ($report['baseline'] ?? null),
                    'after' => $beat['after'] ?? null,
                    'caveat' => $beat['caveat'] ?? null,
                    'restore_ts' => $restoreTs,
                    'created_at' => now()->toIso8601String(),
                ], JSON_PRETTY_PRINT));
            } else {
                File::put("{$dir}/vibe_review.json", json_encode([
                    'status' => 'apply_failed', 'message' => $applied['message'] ?? 'Could not apply.',
                ], JSON_PRETTY_PRINT));
            }
        }

        // Email the outcome: fml@hyperlit.io always (a high-signal bug), and the user too IF they
        // hit "email me when done" mid-run (which dropped a vibe_notify marker with their address).
        if (is_array($report)) {
            try {
                Mail::queue(new VibeOutcomeMail($report, $dir));
                $notifyPath = "{$dir}/vibe_notify";
                if (is_file($notifyPath)) {
                    $email = trim(File::get($notifyPath));
                    if ($email !== '') {
                        Mail::queue(new VibeOutcomeMail($report, $dir, $email));
                    }
                    @unlink($notifyPath);
                }
            } catch (\Throwable $e) {
                Log::warning('VibeConversionJob: email failed', ['book' => $this->bookId, 'err' => $e->getMessage()]);
            }
        }

        $this->releaseConvertLock();   // run finished — let the next vibe start
    }

    /**
     * Release the per-book lock start() acquired (F1). Also called on a thrown
     * failure via failed(); a fatal crash is covered by the lock's TTL.
     */
    private function releaseConvertLock(): void
    {
        Cache::lock("vibe-convert:{$this->bookId}")->forceRelease();
    }

    public function failed(\Throwable $e): void
    {
        $this->releaseConvertLock();
    }

    /** The final phase:"success" beat from vibe_progress.json (carries before/after/tier/caveat). */
    private function lastSuccessBeat(string $dir): array
    {
        $path = "{$dir}/vibe_progress.json";
        if (!is_file($path)) {
            return [];
        }
        $last = [];
        foreach (preg_split('/\r?\n/', trim(File::get($path))) as $line) {
            if ($line === '') {
                continue;
            }
            $b = json_decode($line, true);
            if (is_array($b) && ($b['phase'] ?? '') === 'success') {
                $last = $b;
            }
        }
        return $last;
    }
}
