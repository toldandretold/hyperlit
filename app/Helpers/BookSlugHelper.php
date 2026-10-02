<?php

namespace App\Helpers;

use Illuminate\Support\Facades\DB;

class BookSlugHelper
{
    /**
     * Resolve a slug or book ID to the real book ID.
     * Uses pgsql_admin to bypass RLS — slug resolution is a URL-layer
     * operation; actual access control happens in the controllers.
     */
    public static function resolve(string $bookOrSlug): string
    {
        $db = DB::connection('pgsql_admin');

        // First check if it's a direct book ID
        if ($db->table('library')->where('book', $bookOrSlug)->exists()) {
            return $bookOrSlug;
        }

        // Then check if it's a slug
        $book = $db->table('library')->where('slug', $bookOrSlug)->value('book');
        if ($book) {
            return $book;
        }

        // Return as-is (might be a file-based book or user page)
        return $bookOrSlug;
    }

    /**
     * Get the slug for a given book ID, or null if none is set.
     */
    public static function getSlug(string $bookId): ?string
    {
        return DB::connection('pgsql_admin')
            ->table('library')
            ->where('book', $bookId)
            ->value('slug');
    }

    /**
     * The ONE canonical URL for a book: the slug route when a slug exists,
     * else /book_<id>. Pass $slug when already fetched to avoid a second query.
     */
    public static function canonicalUrl(string $bookId, ?string $slug = null): string
    {
        $slug = $slug ?? self::getSlug($bookId);

        return self::canonicalUrlWithSlug($bookId, $slug);
    }

    /**
     * The same rule, for callers that ALREADY hold the `slug` column — where a
     * NULL means "this book has no slug", not "I didn't fetch it".
     *
     * canonicalUrl()'s `$slug ?? getSlug()` cannot tell those two cases apart,
     * so a slugless book costs it one extra query. That is invisible for a
     * single book page and expensive in a loop: /books renders 50 rows and the
     * sitemap ~324, two thirds of which have no slug. Listing callers pass
     * through here; the URL rule itself stays in one place.
     */
    public static function canonicalUrlWithSlug(string $bookId, ?string $slug): string
    {
        return url(self::canonicalPath($bookId, $slug));
    }

    /**
     * The canonical PATH ("/the-slug"), for callers that need a root-relative
     * href rather than an absolute URL — in-page links the SPA navigation
     * handler intercepts, where swapping to an absolute URL would be a
     * behaviour change for no gain.
     *
     * Exists so those callers don't inline `'/' . ($slug ?: $bookId)` and fork
     * the slug-preferred rule (CLAUDE.md: a book's canonical URL has ONE
     * definition). Takes the already-fetched `slug` column, so it never
     * queries — see canonicalUrlWithSlug.
     */
    public static function canonicalPath(string $bookId, ?string $slug): string
    {
        return '/' . ($slug ?: $bookId);
    }
}
