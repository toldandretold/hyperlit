<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create the import_batches table with RLS policies (mirrors shelves).
     *
     * A batch groups the imports of one multi-file/folder drop (size >= 1 —
     * every file import creates one) so the import-queue widget can fetch
     * "all my active imports" in ONE poll, the worker can add completed books
     * to the batch's auto-shelf, and a single "email me when done" fires when
     * the last item finishes. Live per-book progress stays in progress.json;
     * these rows hold membership + terminal status only.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE import_batches (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id bigint NULL,
                creator varchar NULL,
                creator_token uuid NULL,
                label varchar(255) NOT NULL,
                source varchar(20) NOT NULL DEFAULT 'files',
                shelf_id uuid NULL,
                notify_email boolean NOT NULL DEFAULT false,
                completed_notified_at timestamp NULL,
                dismissed_at timestamp NULL,
                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement("CREATE INDEX import_batches_creator_idx ON import_batches (creator)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX import_batches_token_idx ON import_batches (creator_token)");

        // No DELETE grant/policy — dismissal is an UPDATE (dismissed_at).
        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE ON import_batches TO {$appUser}");

        DB::connection('pgsql_admin')->statement("ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY");
        DB::connection('pgsql_admin')->statement("ALTER TABLE import_batches FORCE ROW LEVEL SECURITY");

        DB::connection('pgsql_admin')->statement("
            CREATE POLICY import_batches_select_policy ON import_batches
            FOR SELECT
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::connection('pgsql_admin')->statement("
            CREATE POLICY import_batches_insert_policy ON import_batches
            FOR INSERT
            WITH CHECK (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");

        DB::connection('pgsql_admin')->statement("
            CREATE POLICY import_batches_update_policy ON import_batches
            FOR UPDATE
            USING (
                (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
            )
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS import_batches_update_policy ON import_batches");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS import_batches_insert_policy ON import_batches");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS import_batches_select_policy ON import_batches");
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS import_batches");
    }
};
