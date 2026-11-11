<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Backs NotificationWriter's per-actor flood cap: "rows from this actor to
     * this recipient in the last hour" runs on every notification write, so it
     * must be an index range scan, not a walk of the recipient's whole feed.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('
            CREATE INDEX IF NOT EXISTS notifications_recipient_actor_created
            ON notifications (recipient, actor, created_at)
        ');
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS notifications_recipient_actor_created');
    }
};
