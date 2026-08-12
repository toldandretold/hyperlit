<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("ALTER TABLE canonical_source ADD COLUMN journal_source_id uuid NULL");
        DB::connection('pgsql_admin')->statement("CREATE INDEX canonical_source_journal_source_id_idx ON canonical_source (journal_source_id)");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("ALTER TABLE canonical_source DROP COLUMN IF EXISTS journal_source_id");
    }
};
