<?php

namespace App\Console\Commands;

use App\Services\Marxists\MarxistsArchive;
use App\Services\Marxists\MarxistsCitation;
use App\Services\ShelfCacheInvalidator;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Give already-imported marxists.org works their real kind — book, article, letter — and the
 * citation that goes with it (`library.type`, the periodical, a letter's year).
 *
 * New imports are classified as they land; this is for the books imported while every one of
 * them was stored as `type = book`, and for re-applying the rules after they change. It reads
 * each book's stored crawl record, never the site. A dry run by default.
 */
class MarxistsClassifyCommand extends Command
{
    protected $signature = 'marxists:classify {author? : Limit to one author of the ledger}
                            {--book= : One book, in the ledger or not (a single-work import)}
                            {--apply : Write the changes (default: only show them)}
                            {--show=12 : Example changes to print per kind}';

    protected $description = 'Classify imported marxists.org works as book / article / letter and fix their citation fields (dry run by default).';

    public function handle(MarxistsCitation $citation, ShelfCacheInvalidator $shelves): int
    {
        $db = DB::connection('pgsql_admin');
        $books = $this->option('book')
            ? collect([(string) $this->option('book')])
            : $db->table('marxists_works')->whereNotNull('book')
                ->when($this->argument('author'), fn ($q, $author) => $q->where('author', $author))
                ->orderBy('id')->pluck('book');
        if ($books->isEmpty()) {
            $this->warn('No imported works to classify.');

            return self::SUCCESS;
        }

        $apply = (bool) $this->option('apply');
        $byGenre = [];
        $examples = [];
        $changed = $noEvidence = $byHand = 0;
        foreach ($books as $book) {
            $plan = $apply ? $citation->apply($book) : $citation->plan($book);
            if ($plan === null) {
                $noEvidence++;
                continue;
            }
            $byGenre[$plan['genre']] = ($byGenre[$plan['genre']] ?? 0) + 1;
            if ($plan['skipped'] !== null) {
                $byHand++;
                continue;
            }
            if ($plan['changes'] !== []) {
                $changed++;
                $examples[$plan['genre']][] = $plan;
            }
        }

        $this->line(($apply ? '<info>Applied.</info> ' : '<comment>Dry run</comment> — nothing written. ') . $books->count() . ' work(s) read.');
        $this->line('  By kind: ' . collect($byGenre)->sortDesc()->map(fn ($n, $genre) => "{$n} {$genre}")->implode(' · '));
        $this->line("  {$changed} " . ($apply ? 'changed' : 'would change')
            . ($byHand ? " · {$byHand} left alone (type already set by hand)" : '')
            . ($noEvidence ? " · {$noEvidence} with no crawl record on disk (cannot be classified)" : ''));

        $show = max(0, (int) $this->option('show'));
        foreach ($examples as $genre => $plans) {
            $this->newLine();
            $this->line("<comment>{$genre}</comment> — " . count($plans) . ' change(s)');
            foreach (array_slice($plans, 0, $show) as $plan) {
                $changes = collect($plan['changes'])->except('note')
                    ->map(fn ($pair, $column) => "{$column}: " . ($pair[0] === null || $pair[0] === '' ? '—' : $pair[0]) . " → {$pair[1]}")->implode(' · ');
                $this->line(sprintf('  %-52s %s', mb_strimwidth($plan['book'], 0, 52, '…'),
                    $changes !== '' ? $changes : 'note tidied'));
            }
            if (count($plans) > $show) {
                $this->line('  … and ' . (count($plans) - $show) . ' more');
            }
        }

        if ($apply && $changed > 0) {
            // The archive page's cards are rendered once and cached; they carry the citation.
            if ($shelf = $db->table('archive_sources')->where('slug', MarxistsArchive::SLUG)->value('shelf_id')) {
                $shelves->flush((string) $shelf);
            }
        } elseif (! $apply && $changed > 0) {
            $this->newLine();
            $this->line('Write these with --apply.');
        }

        return self::SUCCESS;
    }
}
