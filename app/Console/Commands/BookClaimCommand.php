<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Re-own an imported case book (and its footnote sub-books) to a LOCAL account.
 *
 * `book:import-cases` claims a private case book at import time, but it has to
 * GUESS which local admin is the human — the only signal a CLI has is the
 * `sessions` table, and when two admin sessions are alive it can pick the one
 * whose browser you are NOT sitting in. The bundle is parked in `ingested/` by
 * then, so re-running the import is not a recovery path; this is.
 *
 * Dev-only by construction: in production a case book belongs to the real user
 * who reported it, and re-owning it would be theft.
 */
class BookClaimCommand extends Command
{
    protected $signature = 'book:claim
        {book : The book id (sub-books under it are re-owned too)}
        {--owner= : Local username to own it (default: the most recently active admin)}';

    protected $description = 'Re-own an imported case book to a local account (dev triage)';

    public function handle(): int
    {
        if (app()->environment('production')) {
            $this->error('book:claim is a dev-triage tool — never in production.');

            return self::FAILURE;
        }

        $book = (string) $this->argument('book');
        $db = DB::connection('pgsql_admin');

        $row = $db->table('library')->where('book', $book)->first(['creator', 'visibility']);
        if (!$row) {
            $this->error("No local book \"{$book}\".");

            return self::FAILURE;
        }

        $owner = (string) ($this->option('owner') ?: '');
        if ($owner === '') {
            $owner = (string) $db->table('users')
                ->leftJoin('sessions', 'sessions.user_id', '=', 'users.id')
                ->where('users.is_admin', true)
                ->groupBy('users.id', 'users.name')
                ->orderByRaw('max(sessions.last_activity) DESC NULLS LAST')
                ->value('users.name');
            if ($owner === '') {
                $this->error('No local admin to claim it for — pass --owner=<name>.');

                return self::FAILURE;
            }
        }
        if (!$db->table('users')->where('name', $owner)->exists()) {
            $this->error("--owner={$owner} is not a local user.");

            return self::FAILURE;
        }

        if ($owner === $row->creator) {
            $this->info("\"{$book}\" is already owned by {$owner}.");

            return self::SUCCESS;
        }

        $n = $db->table('library')
            ->where(fn ($q) => $q->where('book', $book)->orWhere('book', 'like', $book . '/%'))
            ->update(['creator' => $owner, 'creator_token' => null]);

        $this->info("Claimed \"{$book}\" (+ sub-books, {$n} rows): creator \"{$row->creator}\" → \"{$owner}\".");
        $this->line('  open it at /' . $book . ' logged in as ' . $owner);

        return self::SUCCESS;
    }
}
