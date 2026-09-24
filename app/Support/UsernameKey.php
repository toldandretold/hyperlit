<?php

namespace App\Support;

/**
 * The URL identity of a username — lowercase, spaces stripped.
 *
 * A username IS `users.name`, and its URL form is `/u/{name}` with spaces
 * removed (legacy names may contain spaces; the registration regex forbids
 * them for anything minted since). Casing was never normalised, so `James`
 * and `james` were two accounts fighting over one URL, and `/u/james` 404'd
 * for a user stored as `James`.
 *
 * This is the ONE PHP definition of that key. It MUST stay character-identical
 * in meaning to the SQL expression `lower(replace(name, ' ', ''))` used by:
 *   - the unique index `users_name_url_unique`
 *   - the SECURITY DEFINER function `lookup_user_by_name()`
 * (both in database/migrations/2026_09_24_000001_add_users_name_url_unique_index.php)
 *
 * The database is the authority — this helper exists so PHP-side checks
 * (validation, audits) ask the same question the index answers. `mb_strtolower`
 * and Postgres `lower()` can disagree on exotic Unicode, but every name that
 * can be REGISTERED is ASCII (`alpha_dash` + the [a-zA-Z0-9_-] regex), so they
 * agree everywhere it matters; the index still has the final say.
 *
 * NOTE: this normalises for COMPARISON only. Nothing may rewrite a stored
 * `users.name` — it is a de-facto string foreign key (library.creator,
 * shelves.creator, notifications.recipient, …) compared case-sensitively by
 * ~99 RLS policies against `app.current_user`, so re-casing a user orphans
 * everything they own and revokes their own access to it.
 */
final class UsernameKey
{
    public static function for(string $name): string
    {
        return mb_strtolower(self::forUrl($name));
    }

    /**
     * The URL segment of a username: the STORED casing, spaces stripped.
     *
     * This is what `/u/{name}` carries and what the canonical 301 targets —
     * casing is preserved because the stored name is the account's identity
     * (and the value RLS compares); only the space, which no route pattern
     * accepts, is removed.
     */
    public static function forUrl(string $name): string
    {
        return str_replace(' ', '', $name);
    }

    /** Canonical profile URL for a stored username. */
    public static function profileUrl(string $name): string
    {
        return url('/u/'.self::forUrl($name));
    }

    /** Canonical shelf deep-link for a stored username. */
    public static function shelfUrl(string $name, string $shelfKey): string
    {
        return self::profileUrl($name).'/shelf/'.$shelfKey;
    }

    /**
     * Does a candidate name collide with any value in a list of reserved
     * words? Compared on the key, so `Maintainer` is caught by `maintainer`.
     *
     * @param  array<int, string>  $reserved
     */
    public static function isReserved(string $name, array $reserved): bool
    {
        $key = self::for($name);

        foreach ($reserved as $word) {
            if (self::for((string) $word) === $key) {
                return true;
            }
        }

        return false;
    }
}
