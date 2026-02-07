<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Install the temporal versioning function from nearform/temporal_tables.
     * This function automatically archives old row versions to a history table
     * on UPDATE or DELETE operations.
     *
     * @see https://github.com/nearform/temporal_tables
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Create the versioning trigger function (version 1.2.1)
        // Uses SECURITY DEFINER to bypass RLS for history table inserts
        DB::statement("
            CREATE OR REPLACE FUNCTION versioning()
            RETURNS TRIGGER AS \$\$
            DECLARE
                sys_period text;
                history_table text;
                manipulate jsonb;
                mitigate_update_conflicts text;
                ignore_unchanged_values bool;
                include_current_version_in_history bool;
                commonColumns text[];
                time_stamp_to_use timestamptz;
                range_lower timestamptz;
                existing_range tstzrange;
                holder record;
                holder2 record;
                pg_version integer;
                newVersion record;
                oldVersion record;
                user_defined_system_time text;
            BEGIN
                -- set custom system time if exists
                BEGIN
                    SELECT current_setting('user_defined.system_time') INTO user_defined_system_time;
                    IF NOT FOUND OR (user_defined_system_time <> '') IS NOT TRUE THEN
                        time_stamp_to_use := CURRENT_TIMESTAMP;
                    ELSE
                        SELECT TO_TIMESTAMP(
                            user_defined_system_time,
                            'YYYY-MM-DD HH24:MI:SS.MS.US'
                        ) INTO time_stamp_to_use;
                    END IF;
                EXCEPTION WHEN OTHERS THEN
                    time_stamp_to_use := CURRENT_TIMESTAMP;
                END;

                IF TG_WHEN != 'BEFORE' OR TG_LEVEL != 'ROW' THEN
                    RAISE TRIGGER_PROTOCOL_VIOLATED USING
                        MESSAGE = 'function \"versioning\" must be fired BEFORE ROW';
                END IF;

                IF TG_OP != 'INSERT' AND TG_OP != 'UPDATE' AND TG_OP != 'DELETE' THEN
                    RAISE TRIGGER_PROTOCOL_VIOLATED USING
                        MESSAGE = 'function \"versioning\" must be fired for INSERT or UPDATE or DELETE';
                END IF;

                IF TG_NARGS < 3 THEN
                    RAISE INVALID_PARAMETER_VALUE USING
                        MESSAGE = 'wrong number of parameters for function \"versioning\"',
                        HINT = 'expected at least 3 parameters but got ' || TG_NARGS;
                END IF;

                sys_period := TG_ARGV[0];
                history_table := TG_ARGV[1];
                mitigate_update_conflicts := TG_ARGV[2];
                ignore_unchanged_values := COALESCE(TG_ARGV[3],'false');
                include_current_version_in_history := COALESCE(TG_ARGV[4],'false');

                IF ignore_unchanged_values AND TG_OP = 'UPDATE' THEN
                    IF NEW IS NOT DISTINCT FROM OLD THEN
                        RETURN OLD;
                    END IF;
                END IF;

                -- check if sys_period exists on original table
                SELECT atttypid, attndims INTO holder FROM pg_attribute WHERE attrelid = TG_RELID AND attname = sys_period AND NOT attisdropped;
                IF NOT FOUND THEN
                    RAISE 'column \"%\" of relation \"%\" does not exist', sys_period, TG_TABLE_NAME USING
                        ERRCODE = 'undefined_column';
                END IF;
                IF holder.atttypid != to_regtype('tstzrange') THEN
                    IF holder.attndims > 0 THEN
                        RAISE 'system period column \"%\" of relation \"%\" is not a range but an array', sys_period, TG_TABLE_NAME USING
                            ERRCODE = 'datatype_mismatch';
                    END IF;

                    SELECT rngsubtype INTO holder2 FROM pg_range WHERE rngtypid = holder.atttypid;
                    IF FOUND THEN
                        RAISE 'system period column \"%\" of relation \"%\" is not a range of timestamp with timezone but of type %', sys_period, TG_TABLE_NAME, format_type(holder2.rngsubtype, null) USING
                            ERRCODE = 'datatype_mismatch';
                    END IF;

                    RAISE 'system period column \"%\" of relation \"%\" is not a range but type %', sys_period, TG_TABLE_NAME, format_type(holder.atttypid, null) USING
                        ERRCODE = 'datatype_mismatch';
                END IF;

                IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
                    -- Ignore rows already modified in the current transaction
                    IF OLD.xmin::text = (txid_current() % (2^32)::bigint)::text THEN
                        IF TG_OP = 'DELETE' THEN
                            RETURN OLD;
                        END IF;
                        RETURN NEW;
                    END IF;

                    SELECT current_setting('server_version_num')::integer INTO pg_version;

                    -- check if history table exists
                    IF pg_version < 90600 THEN
                        IF to_regclass(history_table::cstring) IS NULL THEN
                            RAISE 'relation \"%\" does not exist', history_table;
                        END IF;
                    ELSE
                        IF to_regclass(history_table) IS NULL THEN
                            RAISE 'relation \"%\" does not exist', history_table;
                        END IF;
                    END IF;

                    -- check if history table has sys_period
                    IF NOT EXISTS(SELECT * FROM pg_attribute WHERE attrelid = history_table::regclass AND attname = sys_period AND NOT attisdropped) THEN
                        RAISE 'history relation \"%\" does not contain system period column \"%\"', history_table, sys_period USING
                            HINT = 'history relation must contain system period column with the same name and data type as the versioned one';
                    END IF;

                    EXECUTE format('SELECT \$1.%I', sys_period) USING OLD INTO existing_range;

                    IF existing_range IS NULL THEN
                        RAISE 'system period column \"%\" of relation \"%\" must not be null', sys_period, TG_TABLE_NAME USING
                            ERRCODE = 'null_value_not_allowed';
                    END IF;

                    IF isempty(existing_range) OR NOT upper_inf(existing_range) THEN
                        RAISE 'system period column \"%\" of relation \"%\" contains invalid value', sys_period, TG_TABLE_NAME USING
                            ERRCODE = 'data_exception',
                            DETAIL = 'valid ranges must be non-empty and unbounded on the high side';
                    END IF;

                    range_lower := lower(existing_range);

                    IF mitigate_update_conflicts = 'true' THEN
                        -- mitigate update conflicts
                        IF range_lower >= time_stamp_to_use THEN
                            time_stamp_to_use := range_lower + interval '1 microseconds';
                        END IF;
                    END IF;

                    WITH history AS
                        (SELECT attname, atttypid
                        FROM pg_attribute
                        WHERE attrelid = history_table::regclass
                        AND attnum > 0
                        AND NOT attisdropped),
                    main AS
                        (SELECT attname, atttypid
                        FROM pg_attribute
                        WHERE attrelid = TG_RELID
                        AND attnum > 0
                        AND NOT attisdropped)
                    SELECT
                        history.attname AS history_name,
                        main.attname AS main_name,
                        history.atttypid AS history_type,
                        main.atttypid AS main_type
                    INTO holder
                    FROM history
                    INNER JOIN main
                        ON history.attname = main.attname
                    WHERE history.atttypid != main.atttypid;

                    IF FOUND THEN
                        RAISE 'column \"%\" of relation \"%\" is of type % but column \"%\" of history relation \"%\" is of type %',
                            holder.main_name, TG_TABLE_NAME, format_type(holder.main_type, null), holder.history_name, history_table, format_type(holder.history_type, null)
                        USING ERRCODE = 'datatype_mismatch';
                    END IF;

                    WITH history AS
                        (SELECT attname
                        FROM pg_attribute
                        WHERE attrelid = history_table::regclass
                        AND attnum > 0
                        AND NOT attisdropped),
                    main AS
                        (SELECT attname
                        FROM pg_attribute
                        WHERE attrelid = TG_RELID
                        AND attnum > 0
                        AND NOT attisdropped)
                    SELECT array_agg(quote_ident(history.attname)) INTO commonColumns
                    FROM history
                    INNER JOIN main
                        ON history.attname = main.attname
                        AND history.attname != sys_period;

                    -- Insert old version into history with closed time range
                    EXECUTE ('INSERT INTO ' ||
                        history_table ||
                        '(' ||
                        array_to_string(commonColumns , ',') ||
                        ',' ||
                        quote_ident(sys_period) ||
                        ') VALUES (\$1.' ||
                        array_to_string(commonColumns, ',\$1.') ||
                        ',tstzrange(\$2, \$3, ''[)''))')
                    USING OLD, range_lower, time_stamp_to_use;
                END IF;

                IF TG_OP = 'UPDATE' OR TG_OP = 'INSERT' THEN
                    manipulate := jsonb_set('{}'::jsonb, ('{' || sys_period || '}')::text[], to_jsonb(tstzrange(time_stamp_to_use, null, '[)')));
                    RETURN jsonb_populate_record(NEW, manipulate);
                END IF;

                RETURN OLD;
            END;
            \$\$ LANGUAGE plpgsql SECURITY DEFINER;
        ");

        // Grant execute permission to app user
        DB::statement("REVOKE EXECUTE ON FUNCTION versioning() FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION versioning() TO {$appUser}");
    }

    public function down(): void
    {
        DB::statement("DROP FUNCTION IF EXISTS versioning() CASCADE");
    }
};
