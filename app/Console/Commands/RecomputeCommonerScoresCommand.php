<?php

namespace App\Console\Commands;

use App\Services\Commoner\CommonerScoreService;
use Illuminate\Console\Command;

/**
 * Recompute users.commoner_score ("hectares of the commons tilled"). The score
 * is maintained incrementally per-suggester on each suggestion resolution; this
 * command exists for the initial backfill (every user is 0 until it has run
 * once over existing accepted/liked suggestions) and for re-running after the
 * weighting in CommonerScoreService changes.
 */
class RecomputeCommonerScoresCommand extends Command
{
    protected $signature = 'commoner:recompute
                            {--user=* : Restrict to these usernames (repeatable); default is every user}';

    protected $description = 'Recompute users.commoner_score (hosted books, likes, citations, suggested edits)';

    public function handle(CommonerScoreService $scores): int
    {
        $users = $this->option('user') ?: null;

        $this->info($users ? 'Recomputing ' . count($users) . ' user(s)…' : 'Recomputing every user…');

        $changed = $scores->recompute($users);
        $this->info("Rows written: {$changed}");

        return self::SUCCESS;
    }
}
