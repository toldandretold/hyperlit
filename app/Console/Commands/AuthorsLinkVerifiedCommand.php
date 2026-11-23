<?php

namespace App\Console\Commands;

use App\Services\Authors\AuthorLinker;
use App\Services\Authors\AuthorResolver;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Link every existing book whose canonical link is trustworthy to the authors
 * that canonical names (docs/authors.md) — the review of what we already hold.
 *
 * Same rules as a fresh verify (AuthorLinker::linkFromCanonical): known authors
 * by id or exact spelling; an id we hold no author for is looked up on Wikidata
 * and the author created when both sides agree; a bare name we cannot place is
 * left alone and listed.
 *
 * Dry run by default, and a dry run makes no network call unless --lookup asks
 * it to say which authors WOULD be created. Pages by key.
 */
class AuthorsLinkVerifiedCommand extends Command
{
    protected $signature = 'authors:link-verified
                            {--apply : Write links, and queue Wikidata lookups for unknown ids}
                            {--lookup : Dry run only — ask Wikidata now which unknown ids would become authors}
                            {--limit= : Max books to examine}
                            {--book= : Only this book}';

    protected $description = 'Link verified books to the authors their canonical source names.';

    private const MAX_CONSECUTIVE_FAILURES = 5;

    public function handle(AuthorLinker $linker, AuthorResolver $resolver): int
    {
        $apply = (bool) $this->option('apply');
        $limit = $this->option('limit') !== null ? max(1, (int) $this->option('limit')) : null;
        $db = DB::connection('pgsql_admin');

        $linkedBooks = $db->table('library')->whereNotNull('canonical_source_id')->where('book', 'NOT LIKE', '%/%');
        $total = (clone $linkedBooks)->count();
        $trusted = (clone $linkedBooks)->whereIn('canonical_match_method', AuthorLinker::TRUSTED_METHODS);
        $trustedCount = (clone $trusted)->count();

        $this->line(($apply ? 'APPLY' : 'DRY RUN') . " — {$total} book(s) linked to a canonical; {$trustedCount} by a trusted method, "
            . ($total - $trustedCount) . ' by an automated match (left alone).');

        $status = [];
        $linked = [];
        $unknown = [];      // "kind:id" => ['candidate' => …, 'books' => n]
        $unmatched = [];    // name => n
        $seen = 0;

        $query = $this->option('book') ? (clone $trusted)->where('book', $this->option('book')) : $trusted;
        foreach ($query->orderBy('book')->lazyById(500, 'book') as $row) {
            if ($limit !== null && $seen >= $limit) {
                break;
            }
            $seen++;

            $report = $linker->linkFromCanonical($row->book, apply: $apply, dispatchUnknown: $apply);
            $status[$report['status']] = ($status[$report['status']] ?? 0) + 1;

            foreach ($report['linked'] as $l) {
                $linked[] = "  {$row->book}  →  {$l['slug']}  (by {$l['via']})";
            }
            foreach ($report['unknown'] as $candidate) {
                $key = array_key_first($candidate['ids']) . ':' . reset($candidate['ids']);
                $unknown[$key] ??= ['candidate' => $candidate, 'books' => 0];
                $unknown[$key]['books']++;
            }
            foreach ($report['unmatched'] as $name) {
                $unmatched[$name] = ($unmatched[$name] ?? 0) + 1;
            }
        }

        $this->newLine();
        $this->line("Examined {$seen}: " . ($status['linked'] ?? 0) . ' ' . ($apply ? 'linked' : 'would link')
            . ', ' . ($status['nothing_to_link'] ?? 0) . ' name an author we hold nobody for'
            . ', ' . ($status['no_authors'] ?? 0) . ' have a canonical with no author at all.');
        foreach (array_slice($linked, 0, 200) as $line) {
            $this->line($line);
        }
        if (count($linked) > 200) {
            $this->line('  … and ' . (count($linked) - 200) . ' more.');
        }

        $exit = self::SUCCESS;
        if ($unknown !== []) {
            $this->newLine();
            $this->line(count($unknown) . ' author id(s) we hold no author for'
                . ($apply ? ' — Wikidata lookups queued (ResolveBookAuthorsJob).' : '.'));
            if (! $apply && $this->option('lookup')) {
                $exit = $this->lookup($resolver, $unknown);
            } elseif (! $apply) {
                $this->line('  Add --lookup to ask Wikidata now which of them would become authors.');
            }
        }

        if ($unmatched !== []) {
            arsort($unmatched);
            $this->newLine();
            $this->line(count($unmatched) . ' author name(s) with no id and no recorded spelling (left unlinked). Most frequent:');
            foreach (array_slice($unmatched, 0, 30, true) as $name => $n) {
                $this->line("  {$n}×  {$name}");
            }
        }

        if (! $apply) {
            $this->newLine();
            $this->comment('Dry run — nothing written. Re-run with --apply.');
        }

        return $exit;
    }

    /** @param  array<string, array{candidate: array, books: int}>  $unknown */
    private function lookup(AuthorResolver $resolver, array $unknown): int
    {
        $tally = [];
        $failures = 0;

        foreach ($unknown as $key => $entry) {
            $result = $resolver->resolve($entry['candidate'], create: false);
            $tally[$result['status']] = ($tally[$result['status']] ?? 0) + 1;

            if ($result['status'] === 'lookup_failed') {
                if (++$failures >= self::MAX_CONSECUTIVE_FAILURES) {
                    $this->error('Stopped: Wikidata / Open Library failed ' . self::MAX_CONSECUTIVE_FAILURES . ' times in a row.');

                    return 2;
                }
            } else {
                $failures = 0;
            }

            $name = $entry['candidate']['name'] ?? '?';
            $this->line(match ($result['status']) {
                'would_create' => "  CREATE   {$result['label']} ({$result['qid']})  ← {$key}, {$entry['books']} book(s)",
                'existing' => "  existing {$result['label']}  ← {$key}",
                default => "  {$result['status']}  {$name}  ← {$key}",
            });
            usleep(300_000);
        }

        $this->line('  Lookup: ' . implode(', ', array_map(fn ($s, $n) => "{$n} {$s}", array_keys($tally), $tally)) . '.');

        return self::SUCCESS;
    }
}
