<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * `library.meta_updated_at` — "the CITATION METADATA changed", as distinct from
 * `library.timestamp` ("anything changed": it is the client's
 * optimistic-concurrency base and bumps on every content-editing session).
 *
 * The user-home feed cards render exactly seven card-relevant fields (title,
 * author, year, publisher, journal, bibtex, visibility — order is the immutable
 * created_at), but the home-book freshness guard compared against `timestamp`,
 * so every editing session tripped a full card rebuild that produced
 * byte-identical cards AND bumped the home book's timestamp, forcing the
 * client to clear + redownload an unchanged feed (the warm-but-stale path).
 *
 * Maintained by a TRIGGER, not application code, deliberately: metadata
 * writers are scattered (DbLibraryController client syncs, LibraryService
 * imports, reconvert/citation-repair heals, harvest minting, raw DB::table
 * updates), and an app-maintained column inherits the exact failure mode the
 * guard insures against — one forgotten bump = a permanently stale card the
 * guard can no longer see. The trigger compares OLD vs NEW on the seven
 * card-relevant columns mechanically, so every current and future write path
 * is covered for free.
 *
 * Backfill = `timestamp`: home.timestamp ≥ max(real timestamps) after any
 * settle, so users already settled stay settled; users already pending a regen
 * trip exactly once more (same as before this migration), then settle for good.
 */
return new class extends Migration
{
    public function up(): void
    {
        $db = DB::connection('pgsql_admin');

        $db->statement('ALTER TABLE library ADD COLUMN IF NOT EXISTS meta_updated_at BIGINT');
        $db->statement('UPDATE library SET meta_updated_at = COALESCE(timestamp, (extract(epoch from now()) * 1000)::bigint) WHERE meta_updated_at IS NULL');

        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION library_meta_touch() RETURNS trigger AS $$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    NEW.meta_updated_at := (extract(epoch from clock_timestamp()) * 1000)::bigint;
                ELSIF (
                       NEW.title      IS DISTINCT FROM OLD.title
                    OR NEW.author     IS DISTINCT FROM OLD.author
                    OR NEW.year       IS DISTINCT FROM OLD.year
                    OR NEW.publisher  IS DISTINCT FROM OLD.publisher
                    OR NEW.journal    IS DISTINCT FROM OLD.journal
                    OR NEW.bibtex     IS DISTINCT FROM OLD.bibtex
                    OR NEW.visibility IS DISTINCT FROM OLD.visibility
                ) THEN
                    NEW.meta_updated_at := (extract(epoch from clock_timestamp()) * 1000)::bigint;
                END IF;
                RETURN NEW;
            END $$ LANGUAGE plpgsql
        SQL);

        $db->statement('DROP TRIGGER IF EXISTS library_meta_touch_trigger ON library');
        $db->statement('
            CREATE TRIGGER library_meta_touch_trigger
            BEFORE INSERT OR UPDATE ON library
            FOR EACH ROW EXECUTE FUNCTION library_meta_touch()
        ');
    }

    public function down(): void
    {
        $db = DB::connection('pgsql_admin');

        $db->statement('DROP TRIGGER IF EXISTS library_meta_touch_trigger ON library');
        $db->statement('DROP FUNCTION IF EXISTS library_meta_touch()');
        $db->statement('ALTER TABLE library DROP COLUMN IF EXISTS meta_updated_at');
    }
};
