<?php

namespace App\Console\Commands;

use App\Services\JournalHarvest\JournalVersionPromoter;
use Illuminate\Console\Command;

/**
 * Choose which imported lane of a work is THE version.
 *
 * A work harvested with `--lane=both` carries two system versions (the vacuumed PDF and the
 * publisher HTML). Only one can be what readers get, and without this the winner is whichever
 * lane was created first — AutoVersionResolver orders by created_at. This makes the choice
 * explicit, and because pointer assignment is fill-only, nothing later overrides it.
 */
class JournalPromoteVersionCommand extends Command
{
    protected $signature = 'journal:promote-version {book : The lane\'s book id}';

    protected $description = 'Make one imported lane the canonical version of its work: point the canonical at it, list it, and unlist its siblings.';

    public function handle(JournalVersionPromoter $promoter): int
    {
        $book = trim((string) $this->argument('book'));

        $result = $promoter->promote($book);

        if (!$result['promoted']) {
            $this->error("Refused: {$result['reason']}");
            $this->line('  A lane can only be promoted when it has converted content and its');
            $this->line('  conversion_method is a system version (html_scrape_unverified never is —');
            $this->line('  the authenticity gate did not confirm the page IS the article).');

            return 1;
        }

        $this->info("Promoted {$book} — it is now the version readers get.");
        foreach ($result['demoted'] as $sibling) {
            $this->line("  unlisted sibling lane: {$sibling}");
        }

        return 0;
    }
}
