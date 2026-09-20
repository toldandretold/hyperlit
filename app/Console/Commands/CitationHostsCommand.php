<?php

namespace App\Console\Commands;

use App\Services\WebContent\FetchHostHealth;
use Illuminate\Console\Command;

/**
 * Which publishers are costing us citations, what they answered, and what we already tried.
 *
 * The point is not the skip-list — that is a side effect. It is that "we can't read the Economist"
 * stops being folklore and becomes a number with evidence attached, ranked by how many references
 * each host has actually cost. `channels` is the column that decides where effort pays: a host
 * that has only ever seen a plain GET is worth another technique, whereas one that has already
 * refused the browser, the unblocker and JS rendering needs a different idea entirely.
 */
class CitationHostsCommand extends Command
{
    protected $signature = 'citation:hosts
        {--limit=50 : How many hosts to show}
        {--clear= : Lift the cooldown for a host (or "all") and let it be retried}';

    protected $description = 'Report which hosts block citation resolution, and what has been tried on them';

    public function handle(FetchHostHealth $health): int
    {
        if ($clear = $this->option('clear')) {
            $n = $health->clear($clear === 'all' ? null : $clear);
            $this->info("Cleared the cooldown on {$n} host(s)" . ($clear === 'all' ? '' : ": {$clear}"));

            return 0;
        }

        $hosts = $health->costliest((int) $this->option('limit'));

        if ($hosts === []) {
            $this->line('  No blocked hosts recorded yet.');
            $this->line('  They accumulate as citation resolution meets walls — run `citation:web:bench` or a review.');

            return 0;
        }

        $blockedTotal = 0;

        foreach ($hosts as $h) {
            $blockedTotal += (int) $h->citations_blocked;
            $cooling = $h->retry_after !== null && strtotime((string) $h->retry_after) > time();

            $this->newLine();
            $this->line(sprintf(
                '  <fg=%s>%s</> — cost %d citation(s), %d consecutive failure(s)%s',
                $cooling ? 'yellow' : 'default',
                $h->host,
                (int) $h->citations_blocked,
                (int) $h->consecutive_failures,
                (int) $h->successes > 0 ? sprintf(', %d success(es)', (int) $h->successes) : '',
            ));
            $this->line(sprintf('      outcome: %s%s', $h->outcome, $h->http_status ? " (HTTP {$h->http_status})" : ''));
            if ($h->reason) {
                $this->line('      said:    ' . \Illuminate\Support\Str::limit((string) $h->reason, 110));
            }

            $channels = json_decode((string) ($h->channels_tried ?? '[]'), true);
            $channels = is_array($channels) ? $channels : [];
            $this->line('      tried:   ' . ($channels === [] ? '(nothing recorded)' : implode(' → ', $channels)));

            // The actionable line: everything spent, or is there a rung left?
            $exhausted = in_array('unblocker_render', $channels, true) && in_array('browser', $channels, true);
            $this->line(sprintf(
                '      <fg=%s>%s</>',
                $exhausted ? 'red' : 'cyan',
                $exhausted
                    ? 'every channel we own has been spent — needs a NEW technique, not a retry'
                    : 'not all channels tried yet — a retry may succeed',
            ));

            if ($cooling) {
                $this->line('      cooling off until ' . $h->retry_after);
            }
        }

        $this->newLine();
        $this->info(sprintf('  %d host(s) recorded, %d citation(s) lost to them in total.', count($hosts), $blockedTotal));
        $this->line('  Lift a cooldown with --clear=<host> (or --clear=all) after landing a new technique.');

        return 0;
    }
}
