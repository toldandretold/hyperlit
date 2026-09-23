<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Stop archiving history for GENERATED LIBRARY-CARD nodes.
 *
 * The 2026_08_01 migration excluded the fixed-name ranking books, but the
 * per-user feed books (`sam` / `samPrivate` / `samAll`, the `{user}_{vis}_{sort}`
 * sorted variants, the `shelf_{id}_{sort}` renders) could not be excluded by
 * book name — their ids are per-user, and a trigger WHEN clause cannot run a
 * subquery against library.raw_json. Their churn is structural: sorted variants
 * and shelf renders are rebuilt by delete-all + re-insert on every
 * materialization (ranking sorts expire every 15 min by design), so every
 * rebuild archived one history row per card. On production a single user's home
 * books were the two largest entries in nodes_history (224k + 109k rows), and
 * the weekly `nodes:purge-system-history` sweep only mopped up after the fact.
 *
 * The column-level tell that DOES fit a WHEN clause: every generated card node
 * gets a deterministic node_id ending `_card` from LibraryCardGenerator
 * (`{feedBook}_{book}_card`, `{feedBook}_empty_card`, `{feedBook}_balance_card`)
 * — all three feed lanes (UserHomeServerController home books + sorted
 * variants, ShelfController renders) mint through that one generator. Real
 * nodes end in a 9-char base-36 blob (generateDataNodeId / FileHelpers), so a
 * real node matching `%_card` needs its random suffix to spell "card"
 * (~1 in 1.7M) and the only cost of that collision is one node skipping
 * history. NULL node_ids must still version — `x NOT LIKE y` is NULL when x is
 * NULL, which would silently skip real rows, hence the explicit IS NULL arm.
 *
 * Account-ledger entry nodes (`{book}_{ledgerId}`) and About-book nodes keep
 * versioning at the trigger; both stay in the weekly purge's raw_json-typed
 * sweep, which remains the authority for "generated" (GENERATED_TYPES in
 * PurgeSystemNodeHistory).
 */
return new class extends Migration
{
    /** Same fixed list as the 2026_08_01 migration / SearchService / canonicalize. */
    private const SYSTEM_BOOKS = "'stats', 'most-recent', 'most-connected', 'most-lit'";

    public function up(): void
    {
        $db = DB::connection('pgsql_admin');

        $db->statement('DROP TRIGGER IF EXISTS nodes_versioning_trigger ON nodes');
        $db->statement('DROP TRIGGER IF EXISTS nodes_versioning_delete_trigger ON nodes');

        $db->statement('
            CREATE TRIGGER nodes_versioning_trigger
            BEFORE INSERT OR UPDATE ON nodes
            FOR EACH ROW
            WHEN (
                NEW.book NOT IN (' . self::SYSTEM_BOOKS . ")
                AND (NEW.node_id IS NULL OR NEW.node_id NOT LIKE '%\\_card')
            )
            EXECUTE FUNCTION versioning('sys_period', 'nodes_history', 'true')
        ");

        $db->statement('
            CREATE TRIGGER nodes_versioning_delete_trigger
            BEFORE DELETE ON nodes
            FOR EACH ROW
            WHEN (
                OLD.book NOT IN (' . self::SYSTEM_BOOKS . ")
                AND (OLD.node_id IS NULL OR OLD.node_id NOT LIKE '%\\_card')
            )
            EXECUTE FUNCTION versioning('sys_period', 'nodes_history', 'true')
        ");
    }

    public function down(): void
    {
        $db = DB::connection('pgsql_admin');

        $db->statement('DROP TRIGGER IF EXISTS nodes_versioning_trigger ON nodes');
        $db->statement('DROP TRIGGER IF EXISTS nodes_versioning_delete_trigger ON nodes');

        $db->statement('
            CREATE TRIGGER nodes_versioning_trigger
            BEFORE INSERT OR UPDATE ON nodes
            FOR EACH ROW
            WHEN (NEW.book NOT IN (' . self::SYSTEM_BOOKS . '))
            EXECUTE FUNCTION versioning(\'sys_period\', \'nodes_history\', \'true\')
        ');

        $db->statement('
            CREATE TRIGGER nodes_versioning_delete_trigger
            BEFORE DELETE ON nodes
            FOR EACH ROW
            WHEN (OLD.book NOT IN (' . self::SYSTEM_BOOKS . '))
            EXECUTE FUNCTION versioning(\'sys_period\', \'nodes_history\', \'true\')
        ');
    }
};
