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
     * The part a person watching a batch actually wants, as one sentence: how much of THIS batch
     * is done. The totals alone could not say — a work reads `queued` from the moment it is
     * queued until it finishes, and the ledger keeps no batch number.
     *
     * The batch is recovered from the clock: queueing stamps every work of a batch at once, so
     * the oldest stamp among the works still queued is when the batch started, and everything
     * that finished since then belongs to it.
     */
    private function printBatchInProgress($db, \Closure $scope): void
    {
        $queued = $scope($db->table('marxists_works'))->where('status', MarxistsBulkImporter::STATUS_QUEUED);
        $waiting = (clone $queued)->count();
        if ($waiting === 0) {
            $this->line('<comment>No batch running</comment> — nothing is queued.');
            $this->newLine();

            return;
        }
        $startedAt = (string) (clone $queued)->min('updated_at');
        $finished = $scope($db->table('marxists_works'))
            ->whereIn('status', [MarxistsBulkImporter::STATUS_IMPORTED, MarxistsBulkImporter::STATUS_EXISTS,
                MarxistsBulkImporter::STATUS_FAILED, MarxistsBulkImporter::STATUS_NOT_A_WORK])
            ->where('updated_at', '>=', $startedAt)
            ->orderByDesc('updated_at')->get(['status', 'link_title', 'url', 'book', 'updated_at']);

        $done = $finished->count();
        $total = $done + $waiting;
        $failed = $finished->where('status', MarxistsBulkImporter::STATUS_FAILED)->count();
        $this->line(sprintf('<comment>This batch: %d of %d done, %d to go</comment>%s', $done, $total, $waiting,
            $failed ? " — {$failed} FAILED (listed below)" : ''));

        // The job the worker holds right now, read off the queue itself.
        $running = $db->table('jobs')->whereNotNull('reserved_at')
            ->where('payload', 'like', '%ImportMarxistsWorkJob%')->orderBy('reserved_at')->first(['payload', 'reserved_at']);
        $current = null;
        if ($running && preg_match('/workId\\\\?";i:(\d+)/', (string) $running->payload, $m)) {
            $current = $scope($db->table('marxists_works'))->where('id', (int) $m[1])->first(['link_title', 'url']);
        }
        $this->line($current
            ? sprintf('  now fetching  %s  (%s so far)', $this->name($current), $this->span(time() - (int) $running->reserved_at))
            : '  now fetching  nothing — the worker is between jobs, busy with another import, or stopped');

        // Pace from the finishes themselves: first to last, over the gaps between them.
        if ($done >= 3) {
            $elapsed = strtotime((string) $finished->first()->updated_at) - strtotime((string) $finished->last()->updated_at);
            $each = (int) round($elapsed / ($done - 1));
            if ($each > 0) {
                $this->line(sprintf('  fetching left about %s  (%s a work)', $this->span($each * $waiting), $this->span($each)));
            }
        }

        // A fetched book is not readable until it is converted, and the conversions queue up
        // behind the batch's remaining fetches on the same worker.
        $books = $finished->where('status', MarxistsBulkImporter::STATUS_IMPORTED)->pluck('book')->filter()->all();
        if ($books !== []) {
            $converted = $db->table('library')->whereIn('book', $books)->where('has_nodes', true)->count();
            $this->line(sprintf('  converted     %d of the %d fetched so far%s', $converted, count($books),
                $converted < count($books) ? ' — conversions run after the fetches, on the same worker' : ''));
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
