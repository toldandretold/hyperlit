<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->string('slug', 255)->nullable()->after('book');
        });

        // Unique partial index — only non-null slugs must be unique
        DB::unprepared(<<<'SQL'
            CREATE UNIQUE INDEX idx_library_slug ON library(slug) WHERE slug IS NOT NULL;
        SQL);

        // Trigger: prevent slug ↔ book ID collisions
        DB::unprepared(<<<'SQL'
            CREATE OR REPLACE FUNCTION check_slug_book_collision()
            RETURNS TRIGGER AS $$
            BEGIN
                -- When setting/changing a slug, ensure it doesn't match any existing book ID
                IF NEW.slug IS NOT NULL THEN
                    IF EXISTS (SELECT 1 FROM library WHERE book = NEW.slug) THEN
                        RAISE EXCEPTION 'slug "%" collides with an existing book ID', NEW.slug;
                    END IF;
                END IF;
                -- When inserting a new book, ensure the book ID doesn't match any existing slug
                IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.book IS DISTINCT FROM OLD.book) THEN
                    IF EXISTS (SELECT 1 FROM library WHERE slug = NEW.book AND book != NEW.book) THEN
                        RAISE EXCEPTION 'book ID "%" collides with an existing slug', NEW.book;
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        SQL);

        DB::unprepared(<<<'SQL'
            CREATE TRIGGER trg_check_slug_book_collision
            BEFORE INSERT OR UPDATE ON library
            FOR EACH ROW EXECUTE FUNCTION check_slug_book_collision();
        SQL);
    }

    public function down(): void
    {
        DB::unprepared('DROP TRIGGER IF EXISTS trg_check_slug_book_collision ON library;');
        DB::unprepared('DROP FUNCTION IF EXISTS check_slug_book_collision();');
        DB::unprepared('DROP INDEX IF EXISTS idx_library_slug;');

        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn('slug');
        });
    }
};
