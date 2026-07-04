<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * hyperlights.annotation was varchar(1000). An E2EE-encrypted annotation is an
 * hlenc envelope (~1.37× the plaintext + IV/tag overhead), so a legal
 * 1000-char annotation no longer fits once its book is encrypted. Widen to
 * text — the 1000-char PLAINTEXT limit stays enforced in validation.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE hyperlights ALTER COLUMN annotation TYPE text');
    }

    public function down(): void
    {
        // Truncate on rollback (USING avoids a cast error on longer values).
        DB::statement('ALTER TABLE hyperlights ALTER COLUMN annotation TYPE varchar(1000) USING LEFT(annotation, 1000)');
    }
};
