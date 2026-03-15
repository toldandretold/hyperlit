<?php

/**
 * Footnote sub-book visibility trigger
 * =====================================
 *
 * WHY THIS EXISTS:
 * Footnote sub-books are child library records whose content lives inside a
 * parent book. When the parent's visibility changes (e.g. private → public),
 * every footnote sub-book underneath it must follow suit — otherwise readers
 * who can see the parent book will get 403s when they try to open a footnote.
 *
 * This PostgreSQL trigger fires AFTER UPDATE on the library table and
 * automatically propagates the parent's new visibility to all its footnote
 * sub-books in a single UPDATE, regardless of nesting depth.
 *
 * WHY ONLY FOOTNOTES (not hyperlights):
 * Footnotes are integral parts of the book's text — if you can read the book,
 * you should be able to read its footnotes. Hyperlights (annotations) are
 * user-created and may have independent visibility in the future (e.g. a
 * private annotation on a public book). The trigger filters by checking that
 * the last path segment starts with "Fn" to target only footnote sub-books.
 *
 * NOTE: The filter logic in this migration was superseded by
 * 2026_03_15_000001_fix_sub_book_visibility_trigger_depth.php which fixes
 * matching for nested (depth 2+) footnotes.
 */

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::unprepared(<<<'SQL'
            CREATE OR REPLACE FUNCTION sync_footnote_sub_book_visibility()
            RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.visibility IS DISTINCT FROM OLD.visibility
                   AND NEW.type != 'sub_book' THEN
                    UPDATE library
                    SET    visibility = NEW.visibility
                    WHERE  book LIKE NEW.book || '/%'
                      AND  type = 'sub_book'
                      AND  (split_part(book, '/', 2) LIKE 'Fn%' OR split_part(book, '/', 2) LIKE '%\_Fn%');
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            CREATE TRIGGER trg_sync_footnote_sub_book_visibility
            AFTER UPDATE OF visibility ON library
            FOR EACH ROW
            EXECUTE FUNCTION sync_footnote_sub_book_visibility();
        SQL);

        // One-time fix: unlisted + sync visibility to parent for existing footnote sub-books.
        // No-op on prod (backfill hasn't run there yet).
        DB::unprepared(<<<'SQL'
            UPDATE library sub
            SET    listed     = false,
                   visibility = parent.visibility
            FROM   library parent
            WHERE  split_part(sub.book, '/', 1) = parent.book
              AND  sub.type = 'sub_book'
              AND  (split_part(sub.book, '/', 2) LIKE 'Fn%' OR split_part(sub.book, '/', 2) LIKE '%\_Fn%');
        SQL);
    }

    public function down(): void
    {
        DB::unprepared(<<<'SQL'
            DROP TRIGGER IF EXISTS trg_sync_footnote_sub_book_visibility ON library;
            DROP FUNCTION IF EXISTS sync_footnote_sub_book_visibility();
        SQL);
    }
};
