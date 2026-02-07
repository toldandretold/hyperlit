<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Add sys_period column to nodes table for temporal versioning.
     *
     * The sys_period column stores a tstzrange [valid_from, valid_to):
     * - valid_to = null means the row is currently active
     * - On UPDATE/DELETE, the trigger will close the range and archive
     */
    public function up(): void
    {
        // Add sys_period column with default value for existing rows
        DB::statement("
            ALTER TABLE nodes
            ADD COLUMN IF NOT EXISTS sys_period tstzrange
            NOT NULL DEFAULT tstzrange(current_timestamp, null, '[)')
        ");

        // Set sys_period for existing rows based on their created_at timestamp
        // This gives them a valid starting point in history
        DB::statement("
            UPDATE nodes
            SET sys_period = tstzrange(
                COALESCE(created_at, current_timestamp),
                null,
                '[)'
            )
            WHERE sys_period = tstzrange(current_timestamp, null, '[)')
        ");

        // Create GIST index for efficient temporal queries (containment, overlap)
        DB::statement("
            CREATE INDEX IF NOT EXISTS nodes_sys_period_idx
            ON nodes USING GIST (sys_period)
        ");
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS nodes_sys_period_idx');
        DB::statement('ALTER TABLE nodes DROP COLUMN IF EXISTS sys_period');
    }
};
