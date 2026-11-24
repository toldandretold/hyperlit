<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * `selected`: the work is on the author's Selected Works page on marxists.org — the editors'
 * own choice of what matters (Lenin: 37 works of ~3,400). `marxists:list` sets it;
 * `marxists:import --selected` imports those and nothing else. See docs/marxists-import.md.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('ALTER TABLE marxists_works ADD COLUMN selected boolean NOT NULL DEFAULT false');
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('ALTER TABLE marxists_works DROP COLUMN IF EXISTS selected');
    }
};
