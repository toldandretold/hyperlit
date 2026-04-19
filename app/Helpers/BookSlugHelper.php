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
}
