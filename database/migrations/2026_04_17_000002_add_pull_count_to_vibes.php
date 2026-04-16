<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE vibes ADD COLUMN pull_count integer NOT NULL DEFAULT 0
        ");

        DB::connection('pgsql_admin')->statement("
            CREATE INDEX vibes_public_popular_idx ON vibes (visibility, pull_count DESC, created_at DESC)
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("DROP INDEX IF EXISTS vibes_public_popular_idx");
        DB::connection('pgsql_admin')->statement("ALTER TABLE vibes DROP COLUMN IF EXISTS pull_count");
    }
};
