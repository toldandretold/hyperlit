<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create the versioning trigger on the nodes table.
     *
     * This trigger automatically:
     * - On INSERT: Sets sys_period to [now, null) (currently active)
     * - On UPDATE: Archives old version to nodes_history, sets new sys_period
     * - On DELETE: Archives the deleted row to nodes_history with closed range
     *
     * Parameters to versioning():
     * 1. 'sys_period' - name of the temporal range column
     * 2. 'nodes_history' - name of the history table
     * 3. 'true' - mitigate_update_conflicts (adjust timestamps to avoid conflicts)
     */
    public function up(): void
    {
        // Create the trigger on the nodes table
        DB::statement("
            CREATE TRIGGER nodes_versioning_trigger
            BEFORE INSERT OR UPDATE OR DELETE ON nodes
            FOR EACH ROW EXECUTE FUNCTION versioning(
                'sys_period',
                'nodes_history',
                'true'
            )
        ");
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS nodes_versioning_trigger ON nodes');
    }
};
