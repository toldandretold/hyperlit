<?php

namespace App\Console\Commands;

use App\Services\Notifications\NotificationWriter;
use App\Services\Shelves\LicenceReviewShelf;
use App\Support\UsernameKey;
use Illuminate\Console\Command;

/**
 * Keep every user's "Might not be OK to publish" shelf in step with their published books,
 * and tell them (once per flagged set) when it has something on it. See LicenceReviewShelf.
 * Never changes a book's visibility or licence — that is the owner's call.
 */
class LicenceReviewCommand extends Command
{
    protected $signature = 'library:licence-review
        {--user=* : Only these usernames (exact, as stored)}
        {--dry-run : Report what would be shelved, change nothing}';

    protected $description = 'Reconcile licence-review shelves and notify owners of published books that might not be OK to publish';

    public function handle(): int
    {
        $users = array_values(array_filter((array) $this->option('user'))) ?: LicenceReviewShelf::candidateCreators();
        $dry = (bool) $this->option('dry-run');
        $explainer = LicenceReviewShelf::explainerBook();
        $flaggedUsers = 0;
        $flaggedBooks = 0;

        foreach ($users as $user) {
            if ($dry) {
                $books = LicenceReviewShelf::flaggedBooks($user);
                if ($books) {
                    $this->line(sprintf('  %-24s %d book(s): %s', $user, count($books), implode(', ', array_slice($books, 0, 5)) . (count($books) > 5 ? ', …' : '')));
                }
            } else {
                $books = LicenceReviewShelf::reconcile($user);
                if ($books && ($shelf = LicenceReviewShelf::shelfFor($user))) {
                    NotificationWriter::licenceReview($user, $books, UsernameKey::shelfUrl($user, $shelf->slug ?: $shelf->id), $explainer);
                }
            }
            if ($books) {
                $flaggedUsers++;
                $flaggedBooks += count($books);
            }
        }

        $this->info(($dry ? 'Would shelve ' : 'Shelved ') . "{$flaggedBooks} book(s) for {$flaggedUsers} user(s)." . ($explainer ? '' : ' (No copyright explainer configured: set LICENSING_COPYRIGHT_BOOK.)'));

        return self::SUCCESS;
    }
}
