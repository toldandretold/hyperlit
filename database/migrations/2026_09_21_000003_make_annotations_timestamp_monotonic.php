<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Make annotations_updated_at STRICTLY MONOTONIC.
     *
     * The 2025-12-17 function did `SET annotations_updated_at = p_timestamp` —
     * a plain overwrite. That made the value NON-MONOTONIC: a write carrying a
     * timestamp lower than the stored one (server clock jitter, or a client
     * `Date.now()` value maxed in by the library upsert and then a later
     * server-`microtime` SET landing below it) could LOWER it. The reader's
     * freshness gate is `server_ts > local_ts`, so any time a real annotation
     * change failed to raise the server value above what a reader had already
     * cached, that reader NEVER re-fetched and never saw others' new
     * annotations until it wiped IndexedDB (2026-09-21 report).
     *
     * GREATEST(existing + 1, p_timestamp) guarantees EVERY call strictly
     * advances the value by at least 1, in the caller's clock space, and can
     * never go backwards — so a real annotation change is always visible to a
     * reader's `>`/`!=` gate regardless of clock skew between writers.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION update_annotations_timestamp(p_book text, p_timestamp bigint)
            RETURNS boolean
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                book_visibility text;
                updated_count int;
            BEGIN
                SELECT visibility INTO book_visibility
                FROM library
                WHERE book = p_book;

                IF book_visibility IS NULL THEN
                    RETURN false;
                END IF;

                IF book_visibility = 'public'
                   OR EXISTS (
                       SELECT 1 FROM library
                       WHERE book = p_book
                       AND (
                           (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                           OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
                       )
                   )
                THEN
                    -- STRICTLY MONOTONIC: never lower the value, always advance by ≥1.
                    UPDATE library
                    SET annotations_updated_at = GREATEST(COALESCE(annotations_updated_at, 0) + 1, p_timestamp)
                    WHERE book = p_book;

                    GET DIAGNOSTICS updated_count = ROW_COUNT;
                    RETURN updated_count > 0;
                END IF;

                RETURN false;
            END;
            \$\$ LANGUAGE plpgsql;
        ");
    }

    public function down(): void
    {
        // Restore the plain-SET body (2025_12_17_231317).
        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION update_annotations_timestamp(p_book text, p_timestamp bigint)
            RETURNS boolean
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                book_visibility text;
                updated_count int;
            BEGIN
                SELECT visibility INTO book_visibility
                FROM library
                WHERE book = p_book;

                IF book_visibility IS NULL THEN
                    RETURN false;
                END IF;

                IF book_visibility = 'public'
                   OR EXISTS (
                       SELECT 1 FROM library
                       WHERE book = p_book
                       AND (
                           (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                           OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
                       )
                   )
                THEN
                    UPDATE library
                    SET annotations_updated_at = p_timestamp
                    WHERE book = p_book;

                    GET DIAGNOSTICS updated_count = ROW_COUNT;
                    RETURN updated_count > 0;
                END IF;

                RETURN false;
            END;
            \$\$ LANGUAGE plpgsql;
        ");
    }
};
