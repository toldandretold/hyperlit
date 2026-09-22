<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * In-app notifications — a book owner learns someone hyperlighted their
     * book (any sub-book depth), someone's hypercite of their passage got
     * PAIRED (a paste added a citedIN entry), or someone liked their book.
     *
     * Recipients are logged-in users only (recipient = username; anon-owned
     * books are skipped at write time). INSERTs are performed by the ACTOR's
     * request, not the recipient's, so the app role gets NO insert grant —
     * all writes go through pgsql_admin in DB::afterCommit (NotificationWriter).
     * The recipient reads/marks-read/deletes their own rows under RLS.
     *
     * The unique dedupe index is the replay shield: offline-flush re-pushes
     * the same hyperlight/hypercite upserts, and inserts are
     * ON CONFLICT DO NOTHING.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE notifications (
                id bigserial PRIMARY KEY,
                recipient varchar(255) NOT NULL,
                actor varchar(255),
                type varchar(32) NOT NULL,
                book varchar(255) NOT NULL,
                root_book varchar(255) NOT NULL,
                subject_id varchar(255),
                citing_ref varchar(512),
                data jsonb,
                read_at timestamptz,
                created_at timestamptz NOT NULL DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement("
            CREATE UNIQUE INDEX notifications_dedupe
            ON notifications (recipient, type, book, coalesce(subject_id, ''), coalesce(citing_ref, ''))
        ");
        DB::connection('pgsql_admin')->statement('
            CREATE INDEX notifications_recipient_unread
            ON notifications (recipient, read_at)
        ');

        DB::connection('pgsql_admin')->statement("GRANT SELECT, UPDATE, DELETE ON notifications TO {$appUser}");
        DB::connection('pgsql_admin')->statement("GRANT USAGE ON SEQUENCE notifications_id_seq TO {$appUser}");

        DB::connection('pgsql_admin')->statement('ALTER TABLE notifications ENABLE ROW LEVEL SECURITY');
        DB::connection('pgsql_admin')->statement('ALTER TABLE notifications FORCE ROW LEVEL SECURITY');

        // Logged-in recipient only, on every verb — non-empty guard so an
        // anonymous session (app.current_user = '') never matches.
        $ownRow = "
            recipient = current_setting('app.current_user', true)
            AND current_setting('app.current_user', true) IS NOT NULL
            AND current_setting('app.current_user', true) != ''
        ";

        DB::connection('pgsql_admin')->statement("
            CREATE POLICY notifications_select_policy ON notifications
            FOR SELECT USING ({$ownRow})
        ");
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY notifications_update_policy ON notifications
            FOR UPDATE USING ({$ownRow}) WITH CHECK ({$ownRow})
        ");
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY notifications_delete_policy ON notifications
            FOR DELETE USING ({$ownRow})
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP POLICY IF EXISTS notifications_delete_policy ON notifications');
        DB::connection('pgsql_admin')->statement('DROP POLICY IF EXISTS notifications_update_policy ON notifications');
        DB::connection('pgsql_admin')->statement('DROP POLICY IF EXISTS notifications_select_policy ON notifications');
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS notifications');
    }
};
