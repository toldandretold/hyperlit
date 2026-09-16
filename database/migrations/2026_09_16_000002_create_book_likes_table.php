<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Likes — logged-in users only, one per (book, user). RLS'd like shelves
     * (users own their likes), but simpler: no anon branch (no creator_token
     * column) and no UPDATE policy (a like is created or deleted, never
     * edited). Public like COUNTS are read via pgsql_admin in controllers, so
     * RLS never blocks aggregates.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement('
            CREATE TABLE book_likes (
                id bigserial PRIMARY KEY,
                book varchar NOT NULL,
                creator varchar NOT NULL,
                created_at timestamp DEFAULT NOW()
            )
        ');

        DB::connection('pgsql_admin')->statement('CREATE UNIQUE INDEX book_likes_book_creator_unique ON book_likes (book, creator)');
        DB::connection('pgsql_admin')->statement('CREATE INDEX book_likes_book_idx ON book_likes (book)');

        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, DELETE ON book_likes TO {$appUser}");
        DB::connection('pgsql_admin')->statement("GRANT USAGE ON SEQUENCE book_likes_id_seq TO {$appUser}");

        DB::connection('pgsql_admin')->statement('ALTER TABLE book_likes ENABLE ROW LEVEL SECURITY');
        DB::connection('pgsql_admin')->statement('ALTER TABLE book_likes FORCE ROW LEVEL SECURITY');

        // Logged-in owner only, on every verb — non-empty guard so an
        // anonymous session (app.current_user = '') never matches.
        $ownRow = "
            creator = current_setting('app.current_user', true)
            AND current_setting('app.current_user', true) IS NOT NULL
            AND current_setting('app.current_user', true) != ''
        ";

        DB::connection('pgsql_admin')->statement("
            CREATE POLICY book_likes_select_policy ON book_likes
            FOR SELECT USING ({$ownRow})
        ");
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY book_likes_insert_policy ON book_likes
            FOR INSERT WITH CHECK ({$ownRow})
        ");
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY book_likes_delete_policy ON book_likes
            FOR DELETE USING ({$ownRow})
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP POLICY IF EXISTS book_likes_delete_policy ON book_likes');
        DB::connection('pgsql_admin')->statement('DROP POLICY IF EXISTS book_likes_insert_policy ON book_likes');
        DB::connection('pgsql_admin')->statement('DROP POLICY IF EXISTS book_likes_select_policy ON book_likes');
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS book_likes');
    }
};
