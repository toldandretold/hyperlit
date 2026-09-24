<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Usernames become case-insensitive for uniqueness AND URL resolution.
 *
 * A username IS `users.name`, and its URL form is `/u/{name}` with spaces
 * stripped. Two things were wrong with that:
 *
 *  1. There was NO unique constraint on `users.name` at all — uniqueness was
 *     the validation rule `unique:pgsql_admin.users,name` and nothing else.
 *     So it was case-sensitive (`James` and `james` both registerable, then
 *     fighting over one URL, and after the 2026-09-22 squat that is an
 *     impersonation vector) and TOCTOU-racy (two simultaneous signups of the
 *     IDENTICAL name both succeeded; the 23505 catch in the registration
 *     paths could only ever fire for email/user_token).
 *  2. `lookup_user_by_name()` matched `name = p_name` — exact. `/u/james`
 *     was a hard 404 for a user stored as `James`, and since it did not strip
 *     spaces either, a legacy user with a space in their name was redirected
 *     INTO a 404 by routes/web.php (which 301s /MrJohns -> /u/MrJohns).
 *
 * The URL key is `lower(replace(name, ' ', ''))`. That expression is written
 * out literally here rather than wrapped in a helper SQL function on purpose:
 * indexing a user-defined function requires marking it IMMUTABLE, and a later
 * CREATE OR REPLACE of it would silently leave the index built on the old
 * semantics. `lower()` and `replace()` are built-in and immutable, so the raw
 * expression is both indexable and safe. It MUST be written character-
 * identically in the index and in the function below, or the planner will not
 * match one to the other. App\Support\UsernameKey is the PHP-side mirror.
 *
 * NOTHING HERE REWRITES DATA. `users.name` is a de-facto string foreign key
 * with no FK constraints (library.creator, shelves.creator, vibes.creator,
 * hyperlights.creator, hypercites.creator, pinned_books.creator,
 * notifications.recipient, book_reads.user_name, page_views.user_name,
 * user_reading_positions.user_name) and ~99 RLS policies compare it
 * case-sensitively against `app.current_user`. Re-casing one user would
 * orphan everything they own and revoke their own access to it. Existing
 * names stay byte-for-byte; this only constrains NEW rows.
 *
 * DDL runs on pgsql_admin (the BYPASSRLS role) like the other index
 * migrations — the app role can't necessarily create indexes in prod.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Explicit transaction on pgsql_admin. Laravel wraps a migration in a
        // transaction on the migration's OWN connection (the default pgsql) —
        // every statement below runs on a DIFFERENT connection and is
        // therefore outside it. Without this, a failure between the CREATE
        // INDEX and the CREATE OR REPLACE FUNCTION would leave the index in
        // place with the migration unrecorded, and the re-run would die on
        // "already exists". Postgres has transactional DDL; this is also the
        // second reason the index is not built CONCURRENTLY (which cannot run
        // inside a transaction).
        DB::connection('pgsql_admin')->transaction(function () {
            $this->apply(DB::connection('pgsql_admin'));
        });
    }

    private function apply($admin): void
    {
        // Fail readably rather than as a raw 23505 from the index build.
        // Resolving a collision means deciding between two real accounts —
        // a human decision (renaming is destructive, see above), so this
        // refuses rather than guessing.
        $collisions = $admin->select("
            SELECT lower(replace(name, ' ', '')) AS url_key,
                   count(*) AS n,
                   string_agg(DISTINCT name, ', ' ORDER BY name) AS names
            FROM users
            GROUP BY 1
            HAVING count(*) > 1
            ORDER BY 1
        ");

        if ($collisions) {
            // Distinct names only, and capped — one fixture leak can be a
            // hundred identical rows, and an unreadable exception is a
            // useless one.
            $detail = implode('; ', array_map(
                fn ($row) => "{$row->url_key} ({$row->n} rows: ".Str::limit($row->names, 120).')',
                array_slice($collisions, 0, 10)
            ));

            if (count($collisions) > 10) {
                $detail .= '; … '.(count($collisions) - 10).' more';
            }

            throw new RuntimeException(
                'Cannot add users_name_url_unique: '.count($collisions).' username(s) already collide '
                ."case-insensitively: {$detail}. Run `php artisan users:check-name-collisions` and "
                .'resolve them by hand before migrating — this migration will never rename a user.'
            );
        }

        $admin->statement("
            CREATE UNIQUE INDEX IF NOT EXISTS users_name_url_unique
            ON users ((lower(replace(name, ' ', ''))))
        ");

        // Superseded: the non-unique users_name_nospace_idx on
        // (replace(name,' ','')) existed for the catch-all's username lookup,
        // which now goes through lookup_user_by_name() on the lowered
        // expression above. Nothing queries the un-lowered form any more.
        $admin->statement('DROP INDEX IF EXISTS users_name_nospace_idx');

        // CREATE OR REPLACE keeps the existing REVOKE/GRANT on this signature
        // (see 2025_12_18_150000_add_auth_lookup_by_id_function.php), so the
        // app role's EXECUTE survives. Still returns the CANONICAL stored
        // name, which is what every caller needs — UserHomeServerController
        // redirects to it, and it is the value RLS compares.
        $admin->statement("
            CREATE OR REPLACE FUNCTION lookup_user_by_name(p_name text)
            RETURNS TABLE(
                id bigint,
                name varchar,
                created_at timestamp
            )
            STABLE
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT u.id, u.name, u.created_at
                FROM users u
                WHERE lower(replace(u.name, ' ', '')) = lower(replace(p_name, ' ', ''))
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        // RETURNS TABLE(...) puts `id`/`name`/`created_at` in scope as OUT
        // parameters inside the body, so an unqualified `name` is ambiguous
        // with the column. It resolved to the column before, when the body was
        // a bare `WHERE name = p_name` — wrapping it in replace() would have
        // been relying on that silently. Hence the `u` alias above.

        // Re-issue explicitly rather than inheriting the grant by luck of
        // CREATE OR REPLACE preserving the ACL.
        $appUser = config('database.connections.pgsql.username');
        $admin->statement('REVOKE EXECUTE ON FUNCTION lookup_user_by_name(text) FROM PUBLIC');
        $admin->statement("GRANT EXECUTE ON FUNCTION lookup_user_by_name(text) TO \"{$appUser}\"");
    }

    public function down(): void
    {
        $admin = DB::connection('pgsql_admin');

        $admin->statement("
            CREATE OR REPLACE FUNCTION lookup_user_by_name(p_name text)
            RETURNS TABLE(
                id bigint,
                name varchar,
                created_at timestamp
            )
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
                SELECT id, name, created_at
                FROM users
                WHERE name = p_name
                LIMIT 1
            \$\$
            LANGUAGE SQL;
        ");

        $admin->statement("
            CREATE INDEX IF NOT EXISTS users_name_nospace_idx
            ON users ((replace(name, ' ', '')))
        ");

        $admin->statement('DROP INDEX IF EXISTS users_name_url_unique');
    }
};
