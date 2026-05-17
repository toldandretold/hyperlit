<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // canonical_match_score = identity confidence (1.0 for DOI/openalex_id matches,
        // computed metadataScore for title searches). Says "we got the right work."
        //
        // canonical_metadata_score = how well the library row's own metadata aligns with
        // the canonical's. Always computed at link time. When this diverges sharply from
        // canonical_match_score (e.g. score=1.0 from DOI, metadata=0.2), the library
        // row is sloppy/sloppy even though the work is correctly identified.
        Schema::table('library', function (Blueprint $table) {
            $table->decimal('canonical_metadata_score', 5, 4)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn('canonical_metadata_score');
        });
    }
};
