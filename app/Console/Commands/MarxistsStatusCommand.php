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
        $scope = fn ($q) => $q->when($this->argument('author'), fn ($w, $author) => $w->where('author', $author));

        $counts = $scope($db->table('marxists_works'))
            ->selectRaw('author, status, count(*) as n')->groupBy('author', 'status')->orderBy('author')->get();
        if ($counts->isEmpty()) {
            $this->warn('The ledger is empty. Start with: php artisan marxists:list <author>');

            return self::SUCCESS;
        }
        foreach ($counts->groupBy('author') as $author => $rows) {
            $this->line(sprintf('%-11s %s', $author, $rows->map(fn ($r) => "{$r->n} {$r->status}")->implode(' · ')));
        }

        $converted = $scope($db->table('marxists_works as w'))->where('w.status', MarxistsBulkImporter::STATUS_IMPORTED)
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
}
