<?php

namespace App\Console\Commands;

use App\Services\Shelves\AuthorShelf;
use Illuminate\Console\Command;

/**
 * Rebuild every author's shelf from book_authors. The daily backstop for the
 * visibility writers that don't call AuthorShelf themselves (MCP, hosting
 * policy, deletes) — see docs/authors.md.
 */
class AuthorsReconcileCommand extends Command
{
    protected $signature = 'authors:reconcile';

    protected $description = 'Bring every author page\'s shelf into agreement with book_authors.';

    public function handle(): int
    {
        $changed = AuthorShelf::reconcile();
        $this->info("Author shelves reconciled; {$changed} changed.");

        return self::SUCCESS;
    }
}
