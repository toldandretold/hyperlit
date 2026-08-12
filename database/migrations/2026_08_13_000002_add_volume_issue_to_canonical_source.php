<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Volume/issue on the citation identity. The normalised OpenAlex work carries
 * biblio volume/issue but they were dropped at the canonical upsert, so
 * SystemVersionMinter could not copy them onto version books — and journal
 * pages need them for publication-order sorting (year → volume → issue; a
 * bare year is not specific enough for journals shipping several issues a
 * year). Strings, not ints: real-world values include "S1" and "3-4".
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
                ADD COLUMN volume varchar(50) NULL,
                ADD COLUMN issue varchar(50) NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
                DROP COLUMN IF EXISTS volume,
                DROP COLUMN IF EXISTS issue
        ");
    }
};
