<?php

namespace App\Console\Commands;

use App\Jobs\DetectHyperciteCandidatesJob;
use App\Models\JournalSource;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * CLI face of the /maintainer/hypercites detect action — same run row, same
 * job, so the console can watch a CLI-started run and vice versa. The target
 * is a journal slug, or a public shelf's uuid (shelf slugs are only unique
 * per creator, so the id is the unambiguous handle).
 */
class DetectHypercites extends Command
{
    protected $signature = 'hypercites:detect {target : journal_sources slug, or a public shelf uuid}
        {--auto-approve : mint every candidate that clears AutoApprovePolicy (exact, unambiguous, quote-bearing)}
        {--sync : run inline instead of queueing (local testing)}';

    protected $description = 'Detect hypercite candidates across a journal\'s or public shelf\'s citation graph';

    public function handle(): int
    {
        $target = (string) $this->argument('target');
        $db = DB::connection('pgsql_admin');
        $scopeColumn = null;
        $scopeId = null;
        $watchUrl = null;

        if (Str::isUuid($target)) {
            $shelf = $db->table('shelves')->where('id', $target)->where('visibility', 'public')->first();
            if (! $shelf) {
                $this->error("No PUBLIC shelf with id \"{$target}\".");

                return self::FAILURE;
            }
            $scopeColumn = 'shelf_id';
            $scopeId = $shelf->id;
            $watchUrl = "/maintainer/hypercites/shelf/{$shelf->id}";
        } else {
            $journal = JournalSource::where('slug', $target)->first();
            if (! $journal) {
                $this->error("No journal with slug \"{$target}\" — run journal:sync-registry first.");

                return self::FAILURE;
            }
            $scopeColumn = 'journal_source_id';
            $scopeId = $journal->id;
            $watchUrl = "/maintainer/hypercites/{$journal->slug}";
        }

        $runId = (string) Str::uuid();
        $db->table('hypercite_runs')->insert([
            'id'         => $runId,
            $scopeColumn => $scopeId,
            'action'     => 'detect',
            'status'     => 'pending',
            'counts'     => '{}',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $job = new DetectHyperciteCandidatesJob($runId, (bool) $this->option('auto-approve'));

        if ($this->option('sync')) {
            dispatch_sync($job);
            $run = $db->table('hypercite_runs')->where('id', $runId)->first();
            $this->line("status: {$run->status}");
            $this->line("detail: {$run->step_detail}");
            if ($run->error) {
                $this->error($run->error);
            }
            foreach (json_decode((string) $run->counts, true) ?: [] as $k => $v) {
                $this->line(sprintf('  %-24s %s', $k, is_scalar($v) ? $v : json_encode($v)));
            }

            return $run->status === 'completed' ? self::SUCCESS : self::FAILURE;
        }

        dispatch($job);
        $this->info("Run {$runId} queued — watch it at {$watchUrl}");

        return self::SUCCESS;
    }
}
