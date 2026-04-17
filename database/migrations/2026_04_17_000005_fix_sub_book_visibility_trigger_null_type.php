<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Fix: the trigger condition `NEW.type != 'sub_book'` evaluates to NULL
        // (falsy) when the parent book's type is NULL, so the trigger never fires
        // for normal books. Use IS DISTINCT FROM for NULL-safe comparison.
        DB::unprepared(<<<'SQL'
            CREATE OR REPLACE FUNCTION sync_footnote_sub_book_visibility()
            RETURNS TRIGGER AS $$
            BEGIN
                IF NEW.visibility IS DISTINCT FROM OLD.visibility
                   AND NEW.type IS DISTINCT FROM 'sub_book' THEN
                    UPDATE library
                    SET    visibility = NEW.visibility
                    WHERE  book LIKE NEW.book || '/%'
                      AND  type = 'sub_book'
                      AND  substring(book from '/([^/]+)$') LIKE '%Fn%';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        SQL);

        // Backfill: sync existing footnote sub-books that are out of sync
        // with their root book's visibility.
        DB::unprepared(<<<'SQL'
            UPDATE library sub
            SET    visibility = parent.visibility
            FROM   library parent
            WHERE  sub.book LIKE parent.book || '/%'
              AND  sub.type = 'sub_book'
              AND  parent.type IS DISTINCT FROM 'sub_book'
              AND  substring(sub.book from '/([^/]+)$') LIKE '%Fn%'
              AND  sub.visibility IS DISTINCT FROM parent.visibility;
        SQL);
    }

    public function down(): void
    {
        // Restore the previous version (with the != bug)
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
                      AND  substring(book from '/([^/]+)$') LIKE '%Fn%';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        SQL);
    }
};
