<?php

namespace App\Support;

/**
 * The ONE vocabulary for the generated user-home book names.
 *
 * A user's page is backed by generated books whose names are derived from the
 * sanitized username: the system books ({u}, {u}Private, {u}All, {u}Account,
 * {u}About) and the sorted feed variants ({u}_{all|public|private}_{sort}).
 * Every feed-member query must EXCLUDE both sets, and every card mutation
 * must invalidate the sorted variants — with the name lists previously
 * inlined per call site, the sorted-variant pattern was missing from the
 * member queries entirely (a rendered `{u}_all_author` row matched
 * `creator = username`, no slash, no `shelf_` prefix, and showed up as a
 * phantom "…'s library (title)" card in the next regeneration).
 *
 * Explicit name lists, never LIKE patterns: a real book whose slug happens
 * to contain underscores must never be caught by an invalidation delete.
 */
class UserHomeBookNames
{
    public const VISIBILITIES = ['all', 'public', 'private'];

    /**
     * The sort arms renderSortedFeed accepts. 'recent' never mints a variant
     * (it short-circuits to the base book) but is kept in the list so a
     * historical or future row can't dodge invalidation.
     */
    public const SORTS = ['recent', 'title', 'author', 'connected', 'lit'];

    public static function sanitize(string $username): string
    {
        return UsernameKey::forUrl($username);
    }

    /** The five system books generated for a user page. */
    public static function systemBookNames(string $sanitized): array
    {
        return [
            $sanitized,
            $sanitized . 'Private',
            $sanitized . 'All',
            $sanitized . 'Account',
            $sanitized . 'About',
        ];
    }

    /** Every sorted-variant name (all visibilities × all sorts). */
    public static function sortedVariantNames(string $sanitized): array
    {
        return self::sortedVariantNamesFor($sanitized, self::VISIBILITIES);
    }

    /** Sorted-variant names for a subset of visibilities. */
    public static function sortedVariantNamesFor(string $sanitized, array $visibilities): array
    {
        $names = [];
        foreach ($visibilities as $vis) {
            foreach (self::SORTS as $sort) {
                $names[] = "{$sanitized}_{$vis}_{$sort}";
            }
        }

        return $names;
    }

    /** System books + sorted variants: everything a feed-member query excludes. */
    public static function allGeneratedNames(string $sanitized): array
    {
        return array_merge(self::systemBookNames($sanitized), self::sortedVariantNames($sanitized));
    }
}
