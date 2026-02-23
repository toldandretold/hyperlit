<?php

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
                      AND  split_part(book, '/', 2) LIKE 'Fn%';
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
              AND  split_part(sub.book, '/', 2) LIKE 'Fn%';
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
