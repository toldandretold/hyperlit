<?php

namespace App\Console\Commands;

use App\Models\JournalSource;
use Illuminate\Console\Command;

/**
 * The "which journal do I harvest next" view: the diamond registry ranked by
 * citations, with harvest bookkeeping inline.
 */
class JournalListCommand extends Command
{
    protected $signature = 'journal:list
                            {--limit=25 : Rows to show}
                            {--all : Include non-diamond rows too}';

    protected $description = 'List the journal_sources registry ranked by cited_by_count — the harvest worklist.';

    public function handle(): int
    {
        $query = JournalSource::query()
            ->orderByRaw('cited_by_count DESC NULLS LAST');

        if (!$this->option('all')) {
            $query->where('is_diamond', true);
        }

        $journals = $query->limit((int) $this->option('limit'))->get();

        if ($journals->isEmpty()) {
            $this->warn('Registry is empty — run: php artisan journal:sync-registry (or --issn=<issn> for one journal)');
            return 0;
        }

        $this->table(
            ['slug', 'openalex', 'works', 'cited by', 'diamond', 'last harvested', 'name'],
            $journals->map(fn(JournalSource $j) => [
                $j->slug,
                $j->openalex_source_id,
                number_format((int) $j->works_count),
                number_format((int) $j->cited_by_count),
                $j->is_diamond ? 'yes' : 'no',
                $j->last_harvested_at?->format('Y-m-d') ?? '—',
                mb_substr($j->display_name, 0, 50),
            ])->all()
        );

        $this->line('Harvest one with: php artisan journal:harvest <slug> --user=<admin username>');

        return 0;
    }
}
