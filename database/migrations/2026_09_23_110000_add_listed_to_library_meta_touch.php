<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Add `listed` to the library_meta_touch trigger's watched columns.
 *
 * The homepage ranking books' membership is `listed = true` + public
 * visibility, and their skip-if-unchanged guard (HomePageServerController)
 * reads max(meta_updated_at) over that corpus — so a delist/relist must stamp
 * meta_updated_at or the homepage would keep serving a delisted book until
 * some other change happened to trip the guard. Harmless for the user-home
 * guards (a listed flip is metadata-shaped anyway and rare).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement(<<<'SQL'
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
                    OR NEW.listed     IS DISTINCT FROM OLD.listed
                ) THEN
                    NEW.meta_updated_at := (extract(epoch from clock_timestamp()) * 1000)::bigint;
                END IF;
                RETURN NEW;
            END $$ LANGUAGE plpgsql
        SQL);
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement(<<<'SQL'
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
    }
};
