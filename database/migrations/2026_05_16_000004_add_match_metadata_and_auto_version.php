<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Per-link metadata on library: how good the match was, what wave produced it,
        // when it was established, and who established it (so a future admin override
        // can be distinguished from automated matcher output).
        Schema::table('library', function (Blueprint $table) {
            $table->decimal('canonical_match_score', 5, 4)->nullable();
            $table->string('canonical_match_method', 50)->nullable();
            $table->timestamp('canonical_matched_at')->nullable();
            $table->string('canonical_matched_by', 50)->nullable();
        });

        // Quick-draw pointer to the system-generated version (Mistral-OCR of the
        // canonical's verified PDF). Kept separate from author/publisher/commons
        // pointers because it's machine-produced, not human-asserted.
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source ADD COLUMN auto_version_book varchar(255) NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source DROP COLUMN IF EXISTS auto_version_book
        ");

        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn([
                'canonical_match_score',
                'canonical_match_method',
                'canonical_matched_at',
                'canonical_matched_by',
            ]);
        });
    }
};
