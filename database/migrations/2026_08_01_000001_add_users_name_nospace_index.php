<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Functional index for the /{identifier} catch-all's username lookup.
 *
 * Usernames may contain spaces, but their URL form has them stripped, so the
 * route matches `replace(name, ' ', '')` rather than `name`. That expression
 * used to be evaluated in PHP over `User::all()` — every book-by-slug page load
 * walked the whole users table. The route now does it in one query, and this
 * index keeps that query from degrading into a sequential scan as the table
 * grows.
 *
 * DDL runs on pgsql_admin (the BYPASSRLS role) like the other index
 * migrations — the app role can't necessarily create indexes in prod.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            CREATE INDEX IF NOT EXISTS users_name_nospace_idx
            ON users ((replace(name, ' ', '')))
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS users_name_nospace_idx');
    }
};
