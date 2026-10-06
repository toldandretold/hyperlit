<?php

namespace App\Console\Commands;

use App\Support\SlugRules;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * library:backfill-slugs — give readable URLs to books that only have an id.
 *
 * Roughly two thirds of the public corpus lives at /book_1790421435416 or at a
 * raw UUID. Those URLs carry no keyword signal, read as machine-generated, and
 * give a human nothing to recognise in a search result — all three count
 * against the quality threshold Google applies before it indexes a page at all.
 *
 * Nothing breaks when a slug appears. BookSlugHelper::resolve() accepts the
 * book id and the slug equally, so the old URL keeps working, and
 * canonicalUrl() PREFERS the slug — so the moment a slug exists the book's own
 * page, the sitemap and /books all point at it, and Google consolidates the old
 * URL into it on its own. A 301 from the id to the slug would do that faster
 * but is deliberately NOT part of this: TextController::show also serves the
 * SPA, so a blanket redirect there needs its own change and its own testing.
 *
 * Rollback is `slug = NULL` on the affected rows (--undo does exactly that).
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply.
 */
class BackfillBookSlugsCommand extends Command
{
    protected $signature = 'library:backfill-slugs
        {--apply : Actually write the slugs (default is a dry run)}
        {--limit=0 : Only process the first N eligible books (0 = all)}
        {--book= : Only process this one book id}
        {--creator= : Only process books by this creator (exact, case-sensitive — RLS compares it that way)}
        {--include-unlisted : Also slug public books that are not listed}
        {--undo : Clear slugs this command set, identified by --book or --limit}';

    protected $description = 'Generate readable slugs for public books that only have an opaque id';

    public function handle(): int
    {
        if ($this->option('undo')) {
            return $this->undo();
        }

        $apply = (bool) $this->option('apply');
        $books = $this->eligibleBooks();

        if ($books->isEmpty()) {
            $this->info('No eligible books — every public book already has a slug.');

            return self::SUCCESS;
        }

        $this->line(($apply ? 'Applying' : 'DRY RUN —')." slugs for {$books->count()} book(s)");
        $this->newLine();

        $planned = 0;
        $skipped = 0;

        // Slugs minted in this run are not yet in the database during a dry
        // run, so uniqueness has to be tracked here too — otherwise two books
        // with the same title both "get" the same slug and the report lies.
        $claimed = [];

        foreach ($books as $book) {
            $candidate = SlugRules::candidateFrom(
                (string) $book->title,
                $book->author,
                $book->year ? (int) $book->year : null,
            );

            if ($candidate === null) {
                $this->warn("  skip  {$book->book} — title yields no usable slug: \"{$book->title}\"");
                $skipped++;
                continue;
            }

            $slug = $this->firstFree($candidate, $book->book, $claimed);

            if ($slug === null) {
                $this->warn("  skip  {$book->book} — no free slug from \"{$candidate}\"");
                $skipped++;
                continue;
            }

            $claimed[$slug] = true;
            $planned++;

            $this->line("  <info>{$slug}</info>  ← {$book->book}");
            $this->line("        {$book->title}".($book->author ? " · {$book->author}" : ''));

            if ($apply) {
                // pgsql_admin: this is an operator task over the whole corpus,
                // and `library` UPDATE is RLS'd to the row's own creator.
                DB::connection('pgsql_admin')->table('library')
                    ->where('book', $book->book)
                    ->update(['slug' => $slug, 'updated_at' => now()]);
            }
        }

        $this->newLine();
        $this->info(($apply ? 'Wrote' : 'Would write')." {$planned} slug(s); skipped {$skipped}.");

        if (! $apply && $planned > 0) {
            $this->newLine();
            $this->comment('Re-run with --apply to write. Eyeball the list above first —');
            $this->comment('a slug is a public URL and this is the moment to catch a typo.');
        }

        if ($apply && $planned > 0) {
            $this->newLine();
            $this->comment('Flush the sitemap cache so the new URLs are offered now:');
            $this->comment('  php artisan cache:forget sitemap_xml');
        }

        return self::SUCCESS;
    }

    /**
     * Books worth slugging: public, content-bearing, top-level, titled, and
     * without a slug already. Listed-only by default, because an unlisted book
     * is one no human has approved for the homepage/search/sitemap yet and
     * minting its public URL early is a decision, not a cleanup.
     */
    private function eligibleBooks()
    {
        $query = DB::connection('pgsql_admin')->table('library')
            ->select(['book', 'title', 'author', 'year'])
            ->where('visibility', 'public')
            ->whereNull('slug')
            ->whereNotNull('title')
            ->where('title', '!=', '')
            // Sub-books live at /based/{id} and have no slug route at all
            ->where('book', 'not like', '%/%')
            ->orderBy('book');

        if (! $this->option('include-unlisted')) {
            $query->where('listed', true);
        }

        if ($one = $this->option('book')) {
            $query->where('book', $one);
        }

        // Exact and case-sensitive on purpose: `library.creator` is a de-facto
        // string FK that ~99 RLS policies compare case-sensitively, so a
        // case-insensitive match here would scope the run to rows the operator
        // did not mean. See CLAUDE.md, "Usernames are one identity, one URL".
        if ($creator = $this->option('creator')) {
            $query->where('creator', $creator);
        }

        if ($limit = (int) $this->option('limit')) {
            $query->limit($limit);
        }

        return $query->get();
    }

    /**
     * SlugRules::uniqueFrom, plus the slugs claimed earlier in this same run
     * (which the database does not know about during a dry run).
     */
    private function firstFree(string $candidate, string $book, array $claimed): ?string
    {
        for ($n = 1; $n <= 50; $n++) {
            $attempt = $n === 1 ? $candidate : $this->withSuffix($candidate, $n);

            if (isset($claimed[$attempt])) {
                continue;
            }

            if (SlugRules::isAvailable($attempt, $book)) {
                return $attempt;
            }
        }

        return null;
    }

    private function withSuffix(string $candidate, int $n): string
    {
        $suffix = '-'.$n;
        $budget = SlugRules::MAX_LENGTH - strlen($suffix);

        return trim(substr($candidate, 0, $budget), '-').$suffix;
    }

    private function undo(): int
    {
        $one = $this->option('book');

        if (! $one) {
            $this->error('--undo needs --book=<id>: clearing every slug at once would');
            $this->error('destroy hand-set vanity slugs along with the generated ones.');

            return self::FAILURE;
        }

        if (! $this->option('apply')) {
            $this->line("DRY RUN — would clear the slug on {$one}");
            $this->comment('Re-run with --apply to write.');

            return self::SUCCESS;
        }

        DB::connection('pgsql_admin')->table('library')
            ->where('book', $one)
            ->update(['slug' => null, 'updated_at' => now()]);

        $this->info("Cleared the slug on {$one}.");

        return self::SUCCESS;
    }
}
