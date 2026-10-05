<?php

namespace App\Support;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The ONE definition of a valid book slug.
 *
 * A slug is reachable at /{slug} through the `/{identifier}` catch-all, so it
 * shares its namespace with every root route and every username — which makes
 * slug validation a shadowing and impersonation guard, not a formatting
 * preference. The gauntlet lived inline in DbLibraryController::setSlug and is
 * extracted here because a SECOND caller now mints slugs in bulk
 * (library:backfill-slugs), and two copies of an impersonation check is how one
 * of them silently stops matching the other.
 *
 * See CLAUDE.md, "Root routes are book names" and "Usernames are one identity,
 * one URL".
 */
class SlugRules
{
    /** Lowercase alphanumeric + hyphens, 3-60 chars, no leading/trailing hyphen. */
    public const FORMAT = '/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/';

    public const MIN_LENGTH = 3;

    public const MAX_LENGTH = 60;

    /**
     * Why this slug cannot be used, or null if it can.
     *
     * $forBook is the book the slug is being assigned TO — its own existing
     * slug must not read as a collision with itself.
     */
    public static function rejectionReason(string $slug, ?string $forBook = null): ?string
    {
        if (! preg_match(self::FORMAT, $slug)) {
            return 'Slug must be '.self::MIN_LENGTH.'-'.self::MAX_LENGTH
                .' characters, lowercase alphanumeric and hyphens only, '
                .'cannot start or end with a hyphen';
        }

        // A root route would shadow the book outright — the route table wins
        // and /{slug} never reaches the catch-all.
        if (in_array($slug, config('reserved-routes'), true)) {
            return 'This slug is reserved and cannot be used';
        }

        // Reachable at /{slug}, so it can impersonate exactly as a username
        // can. Already lowercased by the format check, so in_array is correct.
        if (in_array($slug, config('reserved-usernames'), true)) {
            return 'This slug is reserved and cannot be used';
        }

        // findByNamePublic, NOT User::where: the default connection is
        // RLS-subject and users_select_policy limits SELECT to your OWN row, so
        // an Eloquent probe finds nobody else and this guard sits inert. Also
        // case-insensitive, which is the point — a slug `marx` while a user
        // `Marx` exists is permanently shadowed by the /{identifier} → /u/
        // redirect.
        if (User::findByNamePublic($slug) !== null) {
            return 'This slug collides with an existing username';
        }

        // Collision checks run on pgsql_admin (RLS-bypassing), NOT the default
        // connection, because the slug namespace is GLOBAL: a PRIVATE book's
        // slug/id still owns /{slug} for everyone (BookSlugHelper::resolve is
        // admin-side; an anonymous visitor gets the access screen, not a 404).
        // Under RLS these probes couldn't see other users' private books, so
        // validation said "available", the partial unique index / trigger then
        // threw, and the caller got a raw 500 — and the backfill command (CLI,
        // no RLS session vars) had the same blind spot. Revealing "taken" here
        // leaks nothing: /{slug} already answers that question to anyone.
        $admin = DB::connection('pgsql_admin');

        if ($admin->table('library')->where('book', $slug)->exists()) {
            return 'This slug collides with an existing book ID';
        }

        $clash = $admin->table('library')->where('slug', $slug);
        if ($forBook !== null) {
            $clash->where('book', '!=', $forBook);
        }
        if ($clash->exists()) {
            return 'This slug is already in use by another book';
        }

        return null;
    }

    public static function isAvailable(string $slug, ?string $forBook = null): bool
    {
        return self::rejectionReason($slug, $forBook) === null;
    }

    /**
     * Turn a title (and optionally an author and year) into a slug candidate,
     * or null when nothing usable survives — a CJK-only or symbol-only title
     * slugs to the empty string, and a 2-character result cannot meet the
     * minimum length.
     *
     * Not responsible for availability: callers pair this with
     * uniqueFrom()/rejectionReason(), because availability is a database
     * question and this is a string one.
     */
    public static function candidateFrom(string $title, ?string $author = null, ?int $year = null): ?string
    {
        $slug = Str::slug($title);

        // An author surname and a year disambiguate the many editions and
        // translations of one work ("capital-marx-1867"), and rescue a title
        // too short to stand alone.
        if ($author !== null && $author !== '' && mb_strlen($slug) < 20) {
            $surname = Str::slug(self::surnameOf($author));
            if ($surname !== '') {
                $slug = trim($slug.'-'.$surname, '-');
            }
        }

        if ($year !== null && $year > 0 && mb_strlen($slug) + 5 <= self::MAX_LENGTH) {
            $slug = $slug.'-'.$year;
        }

        $slug = self::trimToMaxLength($slug);

        return strlen($slug) >= self::MIN_LENGTH ? $slug : null;
    }

    /**
     * The first available slug from $candidate, appending -2, -3, … on
     * collision. Null when every attempt up to $maxAttempts is taken, or when
     * the candidate is rejected for a reason a suffix cannot fix (a reserved
     * word stays reserved however it is numbered).
     */
    public static function uniqueFrom(string $candidate, ?string $forBook = null, int $maxAttempts = 50): ?string
    {
        if (self::isAvailable($candidate, $forBook)) {
            return $candidate;
        }

        for ($n = 2; $n <= $maxAttempts; $n++) {
            $suffix = '-'.$n;
            $attempt = self::trimToMaxLength($candidate, self::MAX_LENGTH - strlen($suffix)).$suffix;

            if (self::isAvailable($attempt, $forBook)) {
                return $attempt;
            }
        }

        return null;
    }

    /**
     * Words a truncated slug must not END on. Cutting mid-sentence routinely
     * lands on a preposition or article — "…-academic-publishing-in-the" — which
     * reads as a broken URL and adds no keyword. Only ever stripped from the
     * TAIL of a cut slug, never from the middle, so "state-of-the-art" survives
     * intact when it fits.
     */
    private const TRAILING_STOPWORDS = [
        'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
        'nor', 'of', 'on', 'or', 'the', 'to', 'with',
    ];

    /**
     * Cut to length without leaving a trailing hyphen (the format regex
     * rejects one) and without splitting the final word when a word boundary
     * is close enough to keep the slug readable.
     */
    private static function trimToMaxLength(string $slug, ?int $max = null): string
    {
        $max = $max ?? self::MAX_LENGTH;

        if (strlen($slug) <= $max) {
            return trim($slug, '-');
        }

        $cut = substr($slug, 0, $max);
        $lastHyphen = strrpos($cut, '-');

        // Only snap back to a word boundary if that keeps most of the budget;
        // otherwise a long first word would collapse the whole slug.
        if ($lastHyphen !== false && $lastHyphen >= (int) ($max * 0.6)) {
            $cut = substr($cut, 0, $lastHyphen);
        }

        return self::dropTrailingStopwords(trim($cut, '-'));
    }

    private static function dropTrailingStopwords(string $slug): string
    {
        $parts = explode('-', $slug);

        // Never strip down to nothing: keep at least one segment, and stop as
        // soon as the result would fall under the minimum length.
        while (count($parts) > 1 && in_array(end($parts), self::TRAILING_STOPWORDS, true)) {
            $candidate = implode('-', array_slice($parts, 0, -1));
            if (strlen($candidate) < self::MIN_LENGTH) {
                break;
            }
            array_pop($parts);
        }

        return implode('-', $parts);
    }

    /**
     * Best-effort surname from a library `author` string, which arrives in
     * both orders ("Marx, Karl" and "Karl Marx") and often holds several
     * authors separated by a semicolon or "and".
     */
    private static function surnameOf(string $author): string
    {
        // First author only — a slug naming four of them is no longer a slug
        $first = preg_split('/\s*(;|\band\b|&)\s*/i', trim($author))[0] ?? '';
        $first = trim($first);

        if ($first === '') {
            return '';
        }

        // "Marx, Karl" → the part before the comma IS the surname
        if (str_contains($first, ',')) {
            return trim(explode(',', $first)[0]);
        }

        // "Karl Marx" → the last word
        $parts = preg_split('/\s+/', $first);

        return (string) end($parts);
    }
}
