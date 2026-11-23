<?php

namespace App\Console\Commands;

use App\Services\Authors\AuthorRegistry;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/** Re-pull authors' Wikidata entities; spellings and ids only ever grow. */
class AuthorsRefreshCommand extends Command
{
    protected $signature = 'authors:refresh {slug? : One author (default: every author with a Wikidata id)}';

    protected $description = 'Refresh author records from Wikidata.';

    public function handle(AuthorRegistry $registry): int
    {
        $authors = DB::connection('pgsql_admin')->table('authors')
            ->whereNotNull('wikidata_qid')
            ->when($this->argument('slug'), fn ($q, $slug) => $q->where('slug', $slug))
            ->orderBy('slug')
            ->get();

        if ($authors->isEmpty()) {
            $this->warn('No matching author with a Wikidata id.');

            return self::FAILURE;
        }

        $failed = 0;
        foreach ($authors as $author) {
            $ok = $registry->refresh($author);
            $failed += $ok ? 0 : 1;
            $this->line(($ok ? '  ok      ' : '  FAILED  ') . $author->slug);
            if ($authors->count() > 1) {
                usleep(300_000);
            }
        }

        return $failed === 0 ? self::SUCCESS : self::FAILURE;
    }
}
