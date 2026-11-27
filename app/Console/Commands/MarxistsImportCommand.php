<?php

namespace App\Console\Commands;

use App\Jobs\ImportMarxistsWorkJob;
use App\Services\Marxists\MarxistsArchive;
use App\Services\Marxists\MarxistsBulkImporter;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Step 2 of the marxists.org bulk import: queue the next batch of an author's listed works.
 *
 * Deliberately a BATCH, not "everything": Lenin alone is ~3,400 works, each a polite crawl plus
 * a conversion on the one serial import worker. Queue some, review them in
 * /maintainer/shelf-import/marxists-org, queue more. Jobs ride the `default` lane, behind any
 * import a person is waiting on. `--selected` is the sensible first pass for an author who has a
 * Selected Works page: a few dozen works the archive's editors chose, not every letter.
 */
class MarxistsImportCommand extends Command
{
    protected $signature = 'marxists:import {author : marx | lenin | trotsky | luxemburg | clr-james}
                            {--limit=10 : How many works to queue in this batch}
                            {--selected : Only works on the Selected Works page of the author (chosen by the archive editors)}
                            {--kind= : Only this kind (work_folder = multi-page works, article, folder_member, undated_index)}
                            {--retry-failed : Queue works whose last attempt failed, instead of new ones}
                            {--now : Run the batch in this terminal instead of queueing it}
                            {--dry-run : Show what would be queued}';

    protected $description = 'Queue the next batch of an author\'s marxists.org works for import.';

    public function handle(MarxistsBulkImporter $importer): int
    {
        $author = (string) $this->argument('author');
        if (! isset(MarxistsArchive::AUTHORS[$author])) {
            $this->error("Unknown author \"{$author}\". Run marxists:list to see them.");

            return self::FAILURE;
        }

        $db = DB::connection('pgsql_admin');
        $from = $this->option('retry-failed') ? MarxistsBulkImporter::STATUS_FAILED : MarxistsBulkImporter::STATUS_LISTED;
        $works = $db->table('marxists_works')
            ->where('author', $author)->where('status', $from)
            ->when($this->option('kind'), fn ($q, $kind) => $q->where('kind', $kind))
            ->when($this->option('selected'), fn ($q) => $q->where('selected', true))
            // Selected works go first in any batch: they are what a reader comes for.
            ->orderByDesc('selected')->orderBy('id')
            ->limit(max(1, (int) $this->option('limit')))
            ->get(['id', 'url', 'link_title', 'kind']);

        if ($works->isEmpty() && $this->option('kind')) {
            // "Nothing left" was untrue here: a kind can be finished while hundreds of works of
            // other kinds are still listed (Marx: every work_folder imported, 343 articles not).
            $left = $db->table('marxists_works')->where('author', $author)->where('status', $from)
                ->when($this->option('selected'), fn ($q) => $q->where('selected', true))
                ->selectRaw('kind, count(*) as n')->groupBy('kind')->orderByDesc('n')->pluck('n', 'kind');
            $this->warn("No {$this->option('kind')} works left for {$author}" . ($this->option('retry-failed') ? ' among the failed ones.' : ' — that kind is done.'));
            $this->line($left->isEmpty()
                ? '  Nothing of any other kind is left either.'
                : '  Still to import, by kind: ' . $left->map(fn ($n, $kind) => "{$n} {$kind}")->implode(' · '));

            return self::SUCCESS;
        }
        if ($works->isEmpty()) {
            $this->warn($this->option('selected') && $from === MarxistsBulkImporter::STATUS_LISTED
                ? "No selected works left to import for {$author}. (marxists:list {$author} flags them; not every author has a Selected Works page.)"
                : ($from === MarxistsBulkImporter::STATUS_LISTED
                ? "Nothing left to import for {$author}. (Run marxists:list {$author} first, or marxists:status.)"
                : "No failed works for {$author}."));

            return self::SUCCESS;
        }

        foreach ($works as $work) {
            $this->line(sprintf('  %-13s %s  %s', $work->kind, str_replace('https://www.marxists.org', '', $work->url), mb_strimwidth((string) $work->link_title, 0, 50, '…')));
        }
        if ($this->option('dry-run')) {
            $this->comment("Dry run — {$works->count()} work(s) would be queued.");

            return self::SUCCESS;
        }

        MarxistsArchive::ensureShelf();
        if ($this->option('now')) {
            config(['queue.default' => 'sync']);
        }

        foreach ($works as $work) {
            // Claimed here, so a second run of this command never queues the same work twice.
            $claimed = $db->table('marxists_works')->where('id', $work->id)->where('status', $from)
                ->update(['status' => MarxistsBulkImporter::STATUS_QUEUED, 'reason' => null, 'updated_at' => now()]);
            if (! $claimed) {
                continue;
            }
            if ($this->option('now')) {
                $status = $importer->importWork((int) $work->id);
                $this->line("    → {$status}  " . str_replace('https://www.marxists.org', '', $work->url));
            } else {
                ImportMarxistsWorkJob::dispatch((int) $work->id)->onQueue('default');
            }
        }

        $this->info($this->option('now')
            ? "Ran {$works->count()} work(s)."
            : "Queued {$works->count()} work(s) on the default lane. Watch: php artisan marxists:status {$author}");
        $this->line('Review: /maintainer/shelf-import/' . MarxistsArchive::SLUG . '   ·   Page: /a/' . MarxistsArchive::SLUG);

        return self::SUCCESS;
    }
}
