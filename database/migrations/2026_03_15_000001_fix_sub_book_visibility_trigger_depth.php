<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Replace the trigger function to match the *last* path segment instead of the 2nd.
        // Level 1: mybook/Fn123        → last segment 'Fn123'  → matches ✅
        // Level 2: mybook/2/Fn123/Fn456 → last segment 'Fn456' → matches ✅
        // Highlight: mybook/2/Fn123/HL_456 → last segment 'HL_456' → excluded ❌
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
                      AND  substring(book from '/([^/]+)$') LIKE 'Fn%';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        SQL);

        // Backfill: sync existing nested footnote sub-books that are out of sync
        // with their root book's visibility.
        DB::unprepared(<<<'SQL'
            UPDATE library sub
            SET    visibility = parent.visibility
            FROM   library parent
            WHERE  sub.book LIKE parent.book || '/%'
              AND  sub.type = 'sub_book'
              AND  parent.type != 'sub_book'
              AND  substring(sub.book from '/([^/]+)$') LIKE 'Fn%'
              AND  sub.visibility IS DISTINCT FROM parent.visibility;
        SQL);
    }

    public function down(): void
    {
        // Restore the original trigger function that only checks split_part(book, '/', 2)
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
        SQL);
    }
};
