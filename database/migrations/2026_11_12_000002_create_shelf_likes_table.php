<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Shelf likes — the book_likes design applied to shelves (and so to the
     * archive / journal pages, whose corpus IS a shelf): logged-in users only,
     * one per (shelf, user), RLS'd so users own their likes, no UPDATE policy
     * (a like is created or deleted). Public COUNTS are read via pgsql_admin.
     * No FK to shelves (the codebase's convention) — ShelfController::destroy
     * deletes a shelf's likes with it.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');
        $db = DB::connection('pgsql_admin');

        $db->statement('
            CREATE TABLE shelf_likes (
                id bigserial PRIMARY KEY,
                shelf_id uuid NOT NULL,
                creator varchar NOT NULL,
                created_at timestamp DEFAULT NOW()
            )
        ');
        $db->statement('CREATE UNIQUE INDEX shelf_likes_shelf_creator_unique ON shelf_likes (shelf_id, creator)');

        $db->statement("GRANT SELECT, INSERT, DELETE ON shelf_likes TO {$appUser}");
        $db->statement("GRANT USAGE ON SEQUENCE shelf_likes_id_seq TO {$appUser}");

        $db->statement('ALTER TABLE shelf_likes ENABLE ROW LEVEL SECURITY');
        $db->statement('ALTER TABLE shelf_likes FORCE ROW LEVEL SECURITY');

        // Logged-in owner only, on every verb — non-empty guard so an
        // anonymous session (app.current_user = '') never matches.
        $ownRow = "
            creator = current_setting('app.current_user', true)
            AND current_setting('app.current_user', true) IS NOT NULL
            AND current_setting('app.current_user', true) != ''
        ";

        $db->statement("CREATE POLICY shelf_likes_select_policy ON shelf_likes FOR SELECT USING ({$ownRow})");
        $db->statement("CREATE POLICY shelf_likes_insert_policy ON shelf_likes FOR INSERT WITH CHECK ({$ownRow})");
        $db->statement("CREATE POLICY shelf_likes_delete_policy ON shelf_likes FOR DELETE USING ({$ownRow})");
    }

    public function down(): void
    {
        $db = DB::connection('pgsql_admin');
        $db->statement('DROP POLICY IF EXISTS shelf_likes_delete_policy ON shelf_likes');
        $db->statement('DROP POLICY IF EXISTS shelf_likes_insert_policy ON shelf_likes');
        $db->statement('DROP POLICY IF EXISTS shelf_likes_select_policy ON shelf_likes');
        $db->statement('DROP TABLE IF EXISTS shelf_likes');
    }
};
