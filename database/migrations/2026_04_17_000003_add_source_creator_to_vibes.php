<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE vibes ADD COLUMN source_creator varchar NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("ALTER TABLE vibes DROP COLUMN IF EXISTS source_creator");
    }
};
