<?php

namespace App\Console\Commands;

use App\Services\System\FailureDigest;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * Export ONE failure group as a self-contained case bundle — the job-failure
 * half of the maintainer loop (the conversion half is book:export). The tarball
 * carries everything a dev machine needs to understand a production failure
 * without ssh: every failed_jobs row in the group, the full stack trace, the
 * decoded payload, worker-log excerpts around each failure, and a README that
 * doubles as the prompt for whoever (or whatever) picks the case up.
 *
 * Counterpart: failure:import-cases.
 */
class FailureExport extends Command
{
    protected $signature = 'failure:export
        {key : The failure group key (12-char id from /maintainer/jobs)}
        {--out= : Output path for the .tar.gz (default storage/app/failure-exports/{key}.tar.gz)}
        {--log-context=40 : Worker-log lines to keep around each failure timestamp}';

    protected $description = 'Export a grouped job failure as a debuggable case bundle';

    private const SCHEMA_VERSION = 1;

    public function handle(FailureDigest $digest): int
    {
        $key = (string) $this->argument('key');
        $group = $digest->group($key);

        if (! $group) {
            $this->error("No failure group '{$key}'. List them: /maintainer/jobs");

            return self::FAILURE;
        }

        $out = $this->option('out') ?: storage_path("app/failure-exports/{$key}.tar.gz");
        File::ensureDirectoryExists(dirname($out));

        $stage = storage_path('app/failure-exports/.stage-' . $key);
        File::deleteDirectory($stage);
        File::ensureDirectoryExists($stage);

        $rows = $group['rows'];
        $latest = end($rows);

        // ── The rows themselves, payload decoded so it is readable ──
        file_put_contents("{$stage}/failures.json", json_encode(array_map(fn ($r) => [
            'id' => $r->id,
            'uuid' => $r->uuid,
            'connection' => $r->connection,
            'queue' => $r->queue,
            'failed_at' => $r->failed_at,
            'payload' => json_decode($r->payload),
            'exception_first_line' => strtok((string) $r->exception, "\n"),
        ], $rows), JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE));

        // ── The full trace of the most recent occurrence ──
        file_put_contents("{$stage}/exception.txt", (string) $latest->exception);

        // ── Context: what this is, where it ran, on what code ──
        file_put_contents("{$stage}/context.json", json_encode([
            'schema_version' => self::SCHEMA_VERSION,
            'key' => $key,
            'job_class' => $group['job_class'],
            'queue' => $group['queue'],
            'count' => $group['count'],
            'first_seen' => $group['first_seen'],
            'last_seen' => $group['last_seen'],
            'message' => $group['message'],
            'paid_class' => $group['paid'],
            'books' => $group['books'],
            'exported_at' => now()->toIso8601String(),
            'app_env' => config('app.env'),
            'app_url' => config('app.url'),
            'git_sha' => $this->gitSha(),
            'php_version' => PHP_VERSION,
            'laravel_version' => app()->version(),
        ], JSON_PRETTY_PRINT));

        // ── Worker log around each failure: what the job was doing at the time ──
        $logLines = $this->workerLogExcerpts($group, (int) $this->option('log-context'));
        file_put_contents("{$stage}/worker-log.txt", $logLines === ''
            ? "(no matching worker log on this host)\n"
            : $logLines);

        // ── Affected books, for failures that cost a user their document ──
        file_put_contents("{$stage}/books.txt", $group['books']
            ? implode("\n", $group['books']) . "\n"
            : "(no book ids found in the payloads)\n");

        file_put_contents("{$stage}/README.md", $this->readme($group, $key));

        $cmd = sprintf('tar -czf %s -C %s .', escapeshellarg($out), escapeshellarg($stage));
        exec($cmd, $o, $code);
        File::deleteDirectory($stage);
        if ($code !== 0) {
            $this->error("tar failed (exit {$code}).");

            return self::FAILURE;
        }

        $this->info("Exported failure group {$key} → {$out}");
        $this->line("  job:        {$group['job_class']}");
        $this->line("  failures:   {$group['count']} ({$group['first_seen']} → {$group['last_seen']})");
        $this->line('  books:      ' . (count($group['books']) ?: 'none identified'));

        return self::SUCCESS;
    }

    /**
     * The bundle's README — deliberately written AS a prompt. Dropping this
     * folder in front of an LLM (or a human at 1am) should be enough to start
     * work without further explanation, the same contract
     * tests/conversion/cases/README.md provides for bad conversions.
     */
    private function readme(array $group, string $key): string
    {
        $name = $group['job_name'];
        $books = $group['books']
            ? implode(', ', array_slice($group['books'], 0, 10)) . (count($group['books']) > 10 ? ' …' : '')
            : 'none identified';
        $paidNote = $group['paid']
            ? "\n**This job costs money.** It calls a paid external API and charges the user on success, so any reproduction you run locally should use a fixture or a dry-run path rather than firing the real request — and a retry in production re-charges.\n"
            : '';

        return <<<MD
        # Production job failure: {$name} × {$group['count']}

        Exported from the `/maintainer/jobs` triage page. Everything here describes ONE failure group — the same job failing the same way — collapsed from the `failed_jobs` table.

        - **Job class** — `{$group['job_class']}`
        - **Queue** — `{$group['queue']}` (worker topology: `deploy/supervisor/README.md`)
        - **Occurrences** — {$group['count']}, from {$group['first_seen']} to {$group['last_seen']}
        - **Message** — `{$group['message']}`
        - **Affected books** — {$books}
        {$paidNote}
        ## What's in here

        - `exception.txt` — the full stack trace of the most recent occurrence. Start here.
        - `failures.json` — every row in the group, payload decoded, so you can see the arguments the job actually ran with.
        - `context.json` — the deployed git sha, PHP/Laravel versions, environment, and the counts above as data.
        - `worker-log.txt` — lines from the queue worker's own log around each failure timestamp: what the job was doing when it died.
        - `books.txt` — book ids extracted from the payloads.

        ## If you are Claude (or any LLM handed this folder)

        1. **Read `exception.txt` first, then the matching source.** The trace names the file and line; that is the fastest route to the real cause. Do not theorise before reading it.
        2. **Check the timeline against deploys.** `context.json` has the git sha. If `first_seen` and `last_seen` cluster around one date, this is an incident (a bad deploy, an OOM, a stale worker holding pre-migration code), not a persistent bug. A failure that stopped on its own was probably fixed by a later commit — confirm with `git log` before "fixing" it again.
        3. **Distinguish the three failure shapes**, because they need different fixes: a **code bug** (fix the code, add a test), an **environment fault** (permissions, missing binary, OOM — fix the host or the deploy, and consider whether the job should fail loudly instead of silently), or a **data-shaped failure** (one book's content breaks an assumption — that's a conversion case, so pull the book with `php artisan book:export <book>` and use the `tests/conversion/cases/` loop instead).
        4. **Reproduce before fixing.** Dispatch the job locally with the arguments from `failures.json` (`php artisan tinker`), or write a failing test that encodes the payload. A fix you cannot make fail first is a guess.
        5. **Ask whether the failure should have been visible.** These sat unseen for months. If the job has no `failed()` handler and a user was waiting on it, adding notification may matter more than the fix itself — check `app/Jobs/{$name}.php`.
        6. **Lock it in.** Add the regression test next to the existing suites in `tests/Feature/`, then run `npm run test:run` and `php artisan test`.
        7. **Hand back.** The human deploys with `./deploy/deploy.sh`, then forgets the group on `/maintainer/jobs` — or retries it there if the work still needs to happen.

        ## If you are a human

        Drop this folder (or its tarball) into `tests/failures/cases/`, or run `php artisan failure:import-cases --downloads` to sweep it out of `~/Downloads` automatically. Then open Claude and say: `@tests/failures/cases/ production job failures to fix`.

        Group key `{$key}` — the same id the triage page uses, so you can find this group again on prod.
        MD;
    }

    /** Worker-log lines bracketing each failure — the job's own account of itself. */
    private function workerLogExcerpts(array $group, int $context): string
    {
        $logs = File::glob(storage_path('logs/*worker*.log'));
        if (! $logs) {
            return '';
        }

        $stamps = array_map(fn ($r) => substr((string) $r->failed_at, 0, 16), $group['rows']);
        $out = [];

        foreach ($logs as $log) {
            $lines = @file($log, FILE_IGNORE_NEW_LINES) ?: [];
            $hits = [];
            foreach ($lines as $i => $line) {
                foreach ($stamps as $stamp) {
                    if (str_contains($line, $stamp)) {
                        $hits[] = [max(0, $i - 5), min(count($lines) - 1, $i + $context)];
                        break;
                    }
                }
            }
            if (! $hits) {
                continue;
            }
            $out[] = '───── ' . basename($log) . ' ─────';
            foreach ($hits as [$from, $to]) {
                $out[] = implode("\n", array_slice($lines, $from, $to - $from + 1));
                $out[] = '…';
            }
        }

        return implode("\n", $out);
    }

    private function gitSha(): string
    {
        $head = base_path('.git/HEAD');
        if (! File::exists($head)) {
            return 'unknown';
        }
        $ref = trim(File::get($head));
        if (str_starts_with($ref, 'ref: ')) {
            $path = base_path('.git/' . substr($ref, 5));

            return File::exists($path) ? substr(trim(File::get($path)), 0, 12) : 'unknown';
        }

        return substr($ref, 0, 12);
    }
}
