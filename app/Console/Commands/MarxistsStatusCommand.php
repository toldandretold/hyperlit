<?php

namespace App\Console\Commands;

use App\Services\Marxists\MarxistsBulkImporter;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/** Where the marxists.org bulk import stands: counts per author and status, and what went wrong. */
class MarxistsStatusCommand extends Command
{
    protected $signature = 'marxists:status {author? : Limit to one author}';

    protected $description = 'Show the marxists.org import ledger: listed / queued / imported / failed, per author.';

    public function handle(): int
    {
        $db = DB::connection('pgsql_admin');
        // `library` has an author column too, so the joined query must name the ledger's.
        $scope = fn ($q, string $column = 'author') => $q->when($this->argument('author'), fn ($w, $author) => $w->where($column, $author));

        $counts = $scope($db->table('marxists_works'))
            ->selectRaw('author, status, count(*) as n')->groupBy('author', 'status')->orderBy('author')->get();
        if ($counts->isEmpty()) {
            $this->warn('The ledger is empty. Start with: php artisan marxists:list <author>');

            return self::SUCCESS;
        }
        $this->printBatchInProgress($db, $scope);

        $this->line('<comment>Totals</comment>');
        foreach ($counts->groupBy('author') as $author => $rows) {
            $this->line(sprintf('  %-11s %s', $author, $rows->map(fn ($r) => "{$r->n} {$r->status}")->implode(' · ')));
        }

        $selected = $scope($db->table('marxists_works'))->where('selected', true)
            ->selectRaw("count(*) as total, count(*) filter (where status = 'imported') as imported")->first();
        if ($selected->total) {
            $this->line("Selected works: {$selected->imported} of {$selected->total} imported.");
        }

        $converted = $scope($db->table('marxists_works as w'), 'w.author')->where('w.status', MarxistsBulkImporter::STATUS_IMPORTED)
            ->join('library as l', 'l.book', '=', 'w.book')
            ->selectRaw('count(*) filter (where l.has_nodes) as done, count(*) as total')->first();
        $this->line("Imported books converted: {$converted->done} of {$converted->total}.");

        $versions = $scope($db->table('marxists_works'))->whereNotNull('same_title_as')->count();
        if ($versions) {
            $this->line("{$versions} imported work(s) share a title with another book by the same author (another version).");
        }

        $problems = $scope($db->table('marxists_works'))
            ->whereIn('status', [MarxistsBulkImporter::STATUS_FAILED, MarxistsBulkImporter::STATUS_NOT_A_WORK])
            ->orderByDesc('updated_at')->limit(15)->get(['status', 'reason', 'url']);
        foreach ($problems as $p) {
            $this->line(sprintf('  %-10s %-22s %s', $p->status, (string) $p->reason, str_replace('https://www.marxists.org', '', $p->url)));
        }

        return self::SUCCESS;
    }

    /**
     * The part a person watching a batch actually wants: is it moving, what is it on, how long
     * is left. The totals alone could not answer that — a work reads `queued` from the moment
     * it is queued until it finishes, so "33 queued" then "25 queued" was the only sign of life.
     */
    private function printBatchInProgress($db, \Closure $scope): void
    {
        $waiting = $scope($db->table('marxists_works'))->where('status', MarxistsBulkImporter::STATUS_QUEUED)->count();
        $recent = $scope($db->table('marxists_works'))
            ->whereIn('status', [MarxistsBulkImporter::STATUS_IMPORTED, MarxistsBulkImporter::STATUS_EXISTS,
                MarxistsBulkImporter::STATUS_FAILED, MarxistsBulkImporter::STATUS_NOT_A_WORK])
            ->where('updated_at', '>=', now()->subHours(2))
            ->orderByDesc('updated_at')->get(['status', 'link_title', 'url', 'updated_at']);
        if ($waiting === 0 && $recent->isEmpty()) {
            return;
        }

        $this->line($waiting > 0 ? '<comment>Batch in progress</comment>' : '<comment>Last batch</comment> (nothing queued now)');

        // The job the worker holds right now, read off the queue itself.
        $running = $db->table('jobs')->whereNotNull('reserved_at')
            ->where('payload', 'like', '%ImportMarxistsWorkJob%')->orderBy('reserved_at')->first(['payload', 'reserved_at']);
        $current = null;
        if ($running && preg_match('/workId\\\\?";i:(\d+)/', (string) $running->payload, $m)) {
            $current = $scope($db->table('marxists_works'))->where('id', (int) $m[1])->first(['link_title', 'url']);
        }
        if ($waiting > 0) {
            $this->line("  {$waiting} still to do" . ($current ? ', including the one running now' : ''));
        }
        if ($current) {
            $this->line(sprintf('  working on   %s  (%s so far)', $this->name($current),
                $this->span(time() - (int) $running->reserved_at)));
        } elseif ($waiting > 0) {
            $this->line('  working on   nothing right now — the worker is between jobs, busy with another import, or stopped');
        }

        $done = $recent->whereIn('status', [MarxistsBulkImporter::STATUS_IMPORTED, MarxistsBulkImporter::STATUS_EXISTS])->count();
        $failed = $recent->where('status', MarxistsBulkImporter::STATUS_FAILED)->count();
        $refused = $recent->where('status', MarxistsBulkImporter::STATUS_NOT_A_WORK)->count();
        $this->line("  last 2 hours {$done} imported" . " · {$failed} failed" . ($failed ? ' (listed below)' : '')
            . ($refused ? " · {$refused} refused (not a single work)" : ''));
        if ($last = $recent->first()) {
            $this->line(sprintf('  last finished %s  (%s ago, %s)', $this->name($last),
                $this->span(time() - strtotime((string) $last->updated_at)), $last->status));
        }

        // Pace from the finishes themselves: first to last, over the gaps between them.
        if ($waiting > 0 && $recent->count() >= 3) {
            $elapsed = strtotime((string) $recent->first()->updated_at) - strtotime((string) $recent->last()->updated_at);
            $each = (int) round($elapsed / ($recent->count() - 1));
            if ($each > 0) {
                $this->line(sprintf('  time left    about %s, at %s a work', $this->span($each * $waiting), $this->span($each)));
            }
        }

        $converting = $scope($db->table('marxists_works as w'), 'w.author')->where('w.status', MarxistsBulkImporter::STATUS_IMPORTED)
            ->join('library as l', 'l.book', '=', 'w.book')->where('l.has_nodes', false)->count();
        if ($converting > 0) {
            $this->line("  {$converting} imported book(s) are fetched and waiting for their conversion (same worker, runs after the fetches)");
        }
        $this->newLine();
    }

    private function name(object $work): string
    {
        $title = trim((string) ($work->link_title ?? ''));

        return $title !== '' ? '“' . mb_strimwidth($title, 0, 60, '…') . '”' : str_replace('https://www.marxists.org', '', (string) $work->url);
    }

    private function span(int $seconds): string
    {
        $seconds = max(0, $seconds);
        if ($seconds < 90) {
            return "{$seconds}s";
        }
        $minutes = (int) round($seconds / 60);

        return $minutes < 90 ? "{$minutes}m" : sprintf('%dh %02dm', intdiv($minutes, 60), $minutes % 60);
    }
}
