<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create the import_items table (one row per book in an import batch).
     *
     * status: pending_upload | upload_failed | queued | processing | complete | failed
     * RLS is inherited from the parent batch via EXISTS; the queue worker's
     * terminal hook writes through pgsql_admin (workers carry no RLS session
     * vars, so app-connection writes would silently match zero rows).
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE import_items (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
                book varchar NOT NULL,
                title varchar(255) NULL,
                filename varchar(255) NULL,
                position integer NOT NULL DEFAULT 0,
                status varchar(20) NOT NULL DEFAULT 'pending_upload',
                error text NULL,
                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW(),
                UNIQUE (batch_id, book)
            )
        ");

        DB::connection('pgsql_admin')->statement("CREATE INDEX import_items_book_idx ON import_items (book)");
        DB::connection('pgsql_admin')->statement("CREATE INDEX import_items_batch_idx ON import_items (batch_id)");

        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE ON import_items TO {$appUser}");

        DB::connection('pgsql_admin')->statement("ALTER TABLE import_items ENABLE ROW LEVEL SECURITY");
        DB::connection('pgsql_admin')->statement("ALTER TABLE import_items FORCE ROW LEVEL SECURITY");

        foreach (['select' => 'FOR SELECT USING', 'insert' => 'FOR INSERT WITH CHECK', 'update' => 'FOR UPDATE USING'] as $name => $clause) {
            DB::connection('pgsql_admin')->statement("
                CREATE POLICY import_items_{$name}_policy ON import_items
                {$clause} (
                    EXISTS (
                        SELECT 1 FROM import_batches b
                        WHERE b.id = batch_id
                          AND (
                            (b.creator IS NOT NULL AND b.creator = current_setting('app.current_user', true))
                            OR (b.creator_token IS NOT NULL AND b.creator_token::text = current_setting('app.current_token', true))
                          )
                    )
                )
            ");
        }
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS import_items_update_policy ON import_items");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS import_items_insert_policy ON import_items");
        DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS import_items_select_policy ON import_items");
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS import_items");
    }
};
