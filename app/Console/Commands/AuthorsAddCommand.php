<?php

namespace App\Console\Commands;

use App\Services\Authors\AuthorRegistry;
use App\Services\Shelves\AuthorShelf;
use Illuminate\Console\Command;

/**
 * Create an author (docs/authors.md). With --wikidata the name, every spelling,
 * the dates and the person's ids on Open Library / OpenAlex are pulled from
 * Wikidata; the flags override or stand in for an author with no entry there.
 * Mints the /a/{slug} page straight away — the maintainer asked for this one.
 */
class AuthorsAddCommand extends Command
{
    protected $signature = 'authors:add {slug : URL key — the page is /a/{slug}}
                            {--wikidata= : Wikidata QID, e.g. Q1394}
                            {--name= : Display name (default: the Wikidata label)}
                            {--sort= : Sort name, e.g. "Lenin, V. I."}
                            {--alias=* : Extra spelling(s) to match on}';

    protected $description = 'Create an author record (filled from Wikidata) and its /a/{slug} page.';

    public function handle(AuthorRegistry $registry): int
    {
        try {
            $author = $registry->ensure(
                $this->argument('slug'),
                $this->option('name'),
                $this->option('wikidata'),
                (array) $this->option('alias'),
                null,
                $this->option('sort'),
            );
        } catch (\DomainException $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        if ($author->slug !== $this->argument('slug')) {
            $this->warn("That Wikidata id is already the author \"{$author->slug}\" — nothing created.");
        } elseif ($this->option('alias')) {
            $registry->addAliases($author, (array) $this->option('alias'));
            $author = $registry->findById($author->id);
        }

        AuthorShelf::ensureFor($author);
        AuthorShelf::sync($author->id);

        $this->info("{$author->display_name}  →  /a/{$author->slug}");
        $this->line('  wikidata: ' . ($author->wikidata_qid ?: '—')
            . '   born–died: ' . ($author->born ?? '?') . '–' . ($author->died ?? ''));
        $this->line('  open library: ' . (implode(', ', json_decode($author->open_library_ids, true) ?: []) ?: '—')
            . '   openalex: ' . (implode(', ', json_decode($author->openalex_ids, true) ?: []) ?: '—'));
        $aliases = json_decode($author->aliases, true) ?: [];
        $this->line('  ' . count($aliases) . ' spellings: ' . implode(' · ', array_slice($aliases, 0, 12)) . (count($aliases) > 12 ? ' …' : ''));
        if ($this->option('wikidata') && ! $author->born && ! $author->died && count($aliases) <= 1 + count((array) $this->option('alias'))) {
            $this->warn('  Wikidata returned nothing (network?). Run authors:refresh ' . $author->slug . ' later.');
        }

        return self::SUCCESS;
    }
}
