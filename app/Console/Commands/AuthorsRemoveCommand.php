<?php

namespace App\Console\Commands;

use App\Services\Authors\AuthorRegistry;
use App\Services\Shelves\AuthorShelf;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/** Delete an author: its book links, its shelf and its /a/ page. Books are untouched. */
class AuthorsRemoveCommand extends Command
{
    protected $signature = 'authors:remove {slug} {--force : Skip the confirmation}';

    protected $description = 'Remove an author record, its links and its /a/{slug} page (for a wrongly created author).';

    public function handle(AuthorRegistry $registry): int
    {
        $author = $registry->findBySlug($this->argument('slug'));
        if (! $author) {
            $this->error('No author "' . $this->argument('slug') . '".');

            return self::FAILURE;
        }

        $links = DB::connection('pgsql_admin')->table('book_authors')->where('author_id', $author->id)->count();
        if (! $this->option('force') && ! $this->confirm("Remove {$author->display_name} (/a/{$author->slug}) and its {$links} book link(s)?")) {
            return self::SUCCESS;
        }

        AuthorShelf::remove($author->id);
        $registry->delete($author);
        $this->info("Removed {$author->slug} ({$links} link(s)).");

        return self::SUCCESS;
    }
}
