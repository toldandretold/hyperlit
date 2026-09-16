<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Like count aggregate, written ONLY by App\Services\Stats\ReadStatsCounter
     * (count of book_likes rows). Nullable, no default: NULL = "never computed",
     * distinguishable from a genuine 0 — same convention as the connection-count
     * columns. Never accepted from a client payload.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('
            ALTER TABLE library
            ADD COLUMN total_likes integer NULL
        ');
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('
            ALTER TABLE library
            DROP COLUMN IF EXISTS total_likes
        ');
    }
};
