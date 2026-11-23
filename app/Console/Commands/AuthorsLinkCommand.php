<?php

namespace App\Console\Commands;

use App\Services\Authors\AuthorLinker;
use App\Services\Authors\AuthorRegistry;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Link (or unlink) ONE book and ONE author by hand — the maintainer's tool for
 * a book no import manifest or verified canonical names an author for.
 */
class AuthorsLinkCommand extends Command
{
    protected $signature = 'authors:link {book : Book id or slug} {slug : Author slug}
                            {--role=author : author | translator | editor | introduction | compiler}
                            {--unlink : Remove the link instead}';

    protected $description = 'Link a book to an author (role-aware); the author page updates at once.';

    public function handle(AuthorRegistry $registry, AuthorLinker $linker): int
    {
        $author = $registry->findBySlug($this->argument('slug'));
        if (! $author) {
            $this->error('No author "' . $this->argument('slug') . '". Create it with authors:add.');

            return self::FAILURE;
        }

        $input = $this->argument('book');
        $book = DB::connection('pgsql_admin')->table('library')
            ->where('book', $input)->orWhere('slug', $input)
            ->first(['book', 'title', 'author', 'visibility']);
        if (! $book) {
            $this->error("No book \"{$input}\".");

            return self::FAILURE;
        }

        $role = (string) $this->option('role');
        try {
            if ($this->option('unlink')) {
                $n = $linker->unlink($book->book, $author->id, $role);
                $this->info($n ? "Unlinked {$book->book} from {$author->slug} ({$role})." : 'No such link.');
            } else {
                $new = $linker->link($book->book, $author->id, $role, 'maintainer');
                $this->info(($new ? 'Linked' : 'Already linked:') . " {$book->book} — \"{$book->title}\" → {$author->slug} ({$role}).");
                if ($role === 'author' && $book->visibility !== 'public') {
                    $this->line("  The book is {$book->visibility}; it joins /a/{$author->slug} when it is public.");
                }
            }
        } catch (\DomainException $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        return self::SUCCESS;
    }
}
