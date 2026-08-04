<?php

namespace App\Console\Commands;

use App\Services\Conversion\HarvestRetraction;
use Illuminate\Console\Command;

/**
 * Bulk-retract harvested versions that should never have been approved —
 * the terminal closer for harvest cases (the /maintainer/conversion 🗑 retract
 * button is the one-off equivalent). Typical prod cleanup after triage:
 *
 *   php artisan harvest:retract --flagged --dry-run   # see what would go
 *   php artisan harvest:retract --flagged             # confirm, then retract
 *
 * Each retraction deletes the version book, clears + re-resolves the
 * canonical's version pointer, and closes the book's open flags as
 * `retracted`. The canonical becomes harvest-eligible again — and the
 * ladder's body-presence gate now rejects the junk that got these in.
 *
 * Guards live in HarvestRetraction: only system-acquired books, and a
 * body-PRESENT book refuses without --force (it may be real content — the
 * Nature quantum-silicon case was flagged alongside 55 genuine junk pages).
 */
class HarvestRetractCommand extends Command
{
    protected $signature = 'harvest:retract
        {book?* : Book id(s) to retract}
        {--flagged : Target every book with an open body_absent flag (the audit\'s flags)}
        {--dry-run : Run the guards and report; delete nothing}
        {--force : Retract even when the stored nodes look body-PRESENT}
        {--yes : Skip the confirmation prompt (for scripted runs)}';

    protected $description = 'Delete junk harvested versions (landing pages / captchas) and free their canonicals for a legitimate re-fetch';

    public function handle(HarvestRetraction $retraction): int
    {
        $books = array_values(array_unique(array_merge(
            (array) $this->argument('book'),
            $this->option('flagged') ? $retraction->flaggedBooks() : [],
        )));

        if ($books === []) {
            $this->info('Nothing to retract — pass book ids or --flagged.');
            return self::SUCCESS;
        }

        $dryRun = (bool) $this->option('dry-run');
        $force = (bool) $this->option('force');

        // Preflight everything first so the confirmation shows the real plan.
        $plan = [];
        foreach ($books as $book) {
            $plan[$book] = $retraction->preflight($book, $force);
        }
        $allowed = array_filter($plan, fn ($p) => $p['allowed']);

        foreach ($plan as $book => $p) {
            if ($p['allowed']) {
                $this->line(sprintf(
                    '  retract  %s  %d prose block(s) / %d chars  %s',
                    $book, $p['prose_blocks'], $p['prose_chars'],
                    mb_strimwidth((string) $p['title'], 0, 60, '…'),
                ));
            } else {
                $this->warn(sprintf('  skip     %s  [%s]%s', $book, $p['refusal'],
                    $p['refusal'] === HarvestRetraction::REFUSED_BODY_PRESENT
                        ? sprintf('  %d prose block(s) — looks REAL; --force to override', $p['prose_blocks'])
                        : ''));
            }
        }

        $this->newLine();
        $this->info(sprintf('%d retractable, %d skipped.', count($allowed), count($plan) - count($allowed)));

        if ($dryRun) {
            $this->line('Dry run — nothing deleted.');
            return self::SUCCESS;
        }
        if ($allowed === []) {
            return self::SUCCESS;
        }

        if (!$this->option('yes') && !$this->confirm(sprintf('Delete %d version book(s) and close their flags?', count($allowed)))) {
            $this->line('Aborted.');
            return self::SUCCESS;
        }

        $done = 0;
        foreach (array_keys($allowed) as $book) {
            $result = $retraction->retract($book, $force);
            if ($result['allowed']) {
                $done++;
                $this->info(sprintf('  retracted %s  (%d flag(s) closed)', $book, $result['flags_resolved'] ?? 0));
            } else {
                // State moved between preflight and now (e.g. parallel resolve).
                $this->warn(sprintf('  skipped   %s  [%s]', $book, $result['refusal']));
            }
        }

        $this->newLine();
        $this->info("{$done} version(s) retracted. Their canonicals are harvest-eligible again — the body gate now guards any re-fetch.");

        return self::SUCCESS;
    }
}
