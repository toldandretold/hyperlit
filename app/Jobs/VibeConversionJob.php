<?php

namespace App\Jobs;

use App\Mail\VibeOutcomeMail;
use App\Models\User;
use App\Services\BillingService;
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
 * run, emails fml@hyperlit.io (and the user, if requested), and bills only on a real result.
 *
 * The patch is applied ONLY in a throwaway sandbox during the loop — production code is never
 * touched. "Use this conversion" (the accept step) is a separate explicit action.
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
    ) {
        $this->onQueue('default');
    }

    public function handle(): void
    {
        $dir = resource_path("markdown/{$this->bookId}");
        if (!is_dir($dir) || !file_exists("{$dir}/assessment.json")) {
            Log::warning('VibeConversionJob: no conversion artifacts', ['book' => $this->bookId]);
            return;
        }

        $progress = "{$dir}/vibe_progress.json";
        $cancel = "{$dir}/vibe_cancel";
        @unlink($progress);  // fresh run
        @unlink($cancel);

        $cmd = [
            env('PYTHON_PATH', 'python3'), base_path('app/Python/vibe_convert.py'), $dir,
            '--max-attempts', '3', '--github',
            '--progress-file', $progress, '--cancel-file', $cancel,
        ];
        if ($this->note) {
            $cmd[] = '--user-note';
            $cmd[] = $this->note;
        }

        $process = new Process($cmd, base_path(), null, null, 1700);
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

        // Bill only when there was a usable result (clean or improved) — fair for an opt-in action.
        $outcome = $report['outcome'] ?? 'unknown';
        if (in_array($outcome, ['clean', 'improved'], true) && $this->userId) {
            $user = User::find($this->userId);
            if ($user) {
                app(BillingService::class)->charge($user, 0.05, 'Vibe conversion: ' . $this->bookId,
                    'vibe_conversion', [], ['book_id' => $this->bookId]);
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
    }
}
