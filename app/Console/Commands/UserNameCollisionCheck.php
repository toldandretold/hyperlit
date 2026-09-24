<?php

namespace App\Console\Commands;

use App\Support\UsernameKey;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Read-only audit: which existing usernames collide on their URL key?
 *
 * A username's URL identity is `lower(replace(name, ' ', ''))` — the form
 * `/u/{name}` resolves on. Uniqueness used to be a case-sensitive validation
 * rule with no DB constraint behind it, so the table can contain names that
 * now fight over one URL (and, since nothing enforced it at all, outright
 * duplicates from racing signups or leaked test fixtures).
 *
 * The unique index `users_name_url_unique` refuses to build while any group
 * here has more than one row, so this is the PRE-FLIGHT for that migration:
 * run it against prod BEFORE deploying, or `php artisan migrate` aborts
 * mid-deploy.
 *
 * Resolving a collision is a HUMAN decision and this command never makes it.
 * Renaming is destructive: `users.name` is a de-facto string foreign key
 * (library.creator, shelves.creator, notifications.recipient, …) that ~99 RLS
 * policies compare case-sensitively against `app.current_user`, so re-casing
 * a live account orphans everything it owns and revokes its own access.
 *
 * Reads on pgsql_admin — the default role is RLS-subject and users_select_policy
 * limits SELECT to your own row, so this audit would otherwise report nothing.
 *
 * Companion: `php artisan routes:check-collisions` (shadowing by a root route).
 */
class UserNameCollisionCheck extends Command
{
    protected $signature = 'users:check-name-collisions';

    protected $description = 'Report usernames that collide on their /u/ URL key (case- and space-insensitive)';

    public function handle(): int
    {
        $db = DB::connection('pgsql_admin');
        $blocking = 0;

        $this->line('URL key = lower(replace(name, \' \', \'\')) — the form /u/{name} resolves on.');

        // --- 1. The blocking one: two users, one URL ---------------------
        $groups = $db->select("
            SELECT lower(replace(name, ' ', '')) AS url_key,
                   count(*) AS n,
                   string_agg(DISTINCT name, ' | ' ORDER BY name) AS names
            FROM users
            GROUP BY 1
            HAVING count(*) > 1
            ORDER BY count(*) DESC, 1
        ");

        if ($groups) {
            $this->newLine();
            $this->error('Colliding usernames — these BLOCK the users_name_url_unique migration:');
            foreach ($groups as $g) {
                $this->line("  /u/{$g->url_key}  ← {$g->n} rows: {$g->names}");
                $this->censusFor($db, $g->url_key);
                $blocking++;
            }
        }

        // --- 2. Reserved words, compared on the key ----------------------
        // The existing audits compare exactly, so an account named `Admin`
        // or `Maintainer` was never reported.
        foreach ([
            'reserved-routes' => 'shadowed by a root route (unreachable at /<name>, still fine at /u/<name>)',
            'reserved-usernames' => 'on the impersonation blocklist',
        ] as $config => $why) {
            $keys = array_map(fn ($w) => UsernameKey::for((string) $w), config($config));
            // whereIn binds each key — a hand-built '{a,b}' array literal would
            // break on any reserved word containing a comma or a brace.
            $hits = $db->table('users')
                ->whereIn(DB::raw("lower(replace(name, ' ', ''))"), $keys)
                ->orderBy('name')
                ->pluck('name');

            if ($hits->isNotEmpty()) {
                $this->newLine();
                $this->warn("Usernames {$why}:");
                foreach ($hits as $name) {
                    $this->line("  {$name}");
                }
            }
        }

        // --- 3. A username whose key is also ANOTHER user's book ---------
        // /{identifier} resolves a user BEFORE a book, so the book loses.
        // A user's OWN pseudo-books (the /u/ page mints library rows named
        // after their creator — `{name}`, `{name}All`, `{name}About`, …) are
        // excluded: those are the same identity, not a collision.
        $shadowed = $db->select("
            SELECT u.name AS username, l.book, l.slug, l.creator
            FROM users u
            JOIN library l
              ON lower(replace(u.name, ' ', '')) IN (lower(l.slug), lower(l.book))
            WHERE l.creator IS DISTINCT FROM u.name
            ORDER BY u.name
            LIMIT 50
        ");

        if ($shadowed) {
            $this->newLine();
            $this->warn("Usernames that shadow someone else's book (the catch-all resolves the user first):");
            foreach ($shadowed as $row) {
                $this->line("  {$row->username}  ← book {$row->book}".($row->slug ? " (slug {$row->slug})" : '')." by {$row->creator}");
            }
        }

        $this->newLine();
        if ($blocking === 0) {
            $this->info('✓ No colliding usernames — users_name_url_unique can be created.');

            return self::SUCCESS;
        }

        $this->line("{$blocking} collision group(s) must be resolved by hand before migrating.");
        $this->line('This command never renames anyone: users.name is compared case-sensitively by RLS,');
        $this->line('so re-casing a live account orphans its books, shelves, highlights and notifications.');

        return self::FAILURE;
    }

    /**
     * What does each member of a colliding group actually own?
     *
     * Without this, "resolve it by hand" is a shrug. `users.name` is a
     * de-facto foreign key across these tables with no FK constraint, so an
     * account holding zero rows everywhere is safe to delete and one holding
     * books is not — that is the whole decision, and it should be visible
     * without writing ad-hoc SQL against prod.
     */
    private function censusFor($db, string $urlKey): void
    {
        // Capped: the census is 10 counts per member over big tables, and a
        // leaked test fixture can be hundreds of identical rows — uncapped,
        // one such group turned this audit into a two-minute query storm.
        // Five is enough to make the "which of these is the real account"
        // decision; a group larger than that is fixture leakage, not a tie.
        $limit = 5;

        $members = $db->table('users')
            ->whereRaw("lower(replace(name, ' ', '')) = ?", [$urlKey])
            ->orderBy('id')
            ->limit($limit + 1)
            ->get(['id', 'name', 'email', 'created_at', 'email_verified_at']);

        $overflow = $members->count() > $limit;
        $members = $members->take($limit);

        // table => column holding the username
        $owned = [
            'library' => 'creator',
            'shelves' => 'creator',
            'vibes' => 'creator',
            'hyperlights' => 'creator',
            'hypercites' => 'creator',
            'pinned_books' => 'creator',
            'notifications' => 'recipient',
            'book_reads' => 'user_name',
            'page_views' => 'user_name',
            'user_reading_positions' => 'user_name',
        ];

        foreach ($members as $m) {
            $counts = [];
            foreach ($owned as $table => $column) {
                try {
                    // exists(), not count(): most of these columns are
                    // unindexed and some of the tables (page_views,
                    // book_reads) are huge, so a full COUNT per member per
                    // table took minutes. "Does this account own anything
                    // here" is the whole decision anyway, and EXISTS stops at
                    // the first row.
                    if ($db->table($table)->where($column, $m->name)->exists()) {
                        $counts[] = $table;
                    }
                } catch (\Throwable $e) {
                    continue; // table absent in this environment — not fatal to an audit
                }
            }

            $verified = $m->email_verified_at ? 'verified' : 'UNVERIFIED';
            $owns = $counts ? 'owns rows in '.implode(', ', $counts) : 'owns nothing';
            $this->line("      #{$m->id} {$m->name} <{$m->email}> created {$m->created_at} [{$verified}] — {$owns}");
        }

        if ($overflow) {
            $this->line("      … more rows in this group; only the first {$limit} are censused.");
        }
    }
}
