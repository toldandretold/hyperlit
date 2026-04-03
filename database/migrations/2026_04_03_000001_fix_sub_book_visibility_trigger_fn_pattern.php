<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Fix the LIKE pattern: footnote sub-book IDs from process_document.py
        // have the format "seq{n}_Fn{timestamp}_{suffix}", so the last path
        // segment starts with "seq1_", not "Fn". Use '%Fn%' to match both
        // old-style "Fn123" and new-style "seq1_Fn1775167216655_0dov" IDs.
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

        // Backfill: sync existing footnote sub-books that are out of sync
        // with their parent book's visibility.
        DB::unprepared(<<<'SQL'
            UPDATE library sub
            SET    visibility = parent.visibility
            FROM   library parent
            WHERE  sub.book LIKE parent.book || '/%'
              AND  sub.type = 'sub_book'
              AND  parent.type != 'sub_book'
              AND  substring(sub.book from '/([^/]+)$') LIKE '%Fn%'
              AND  sub.visibility IS DISTINCT FROM parent.visibility;
        SQL);
    }

    public function down(): void
    {
        // Restore the previous pattern (LIKE 'Fn%') from the depth fix migration
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
    }
};
