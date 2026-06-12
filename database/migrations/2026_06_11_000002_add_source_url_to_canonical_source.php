<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Identity key for WEB canonicals. A non-academic source (news/blog) has no
 * DOI/OpenAlex id — its identity is its URL. `source_url` lets web-verified
 * sources dedup to one canonical (so multiple library rows for the same URL
 * group as versions), without pretending it's an academic work: such a
 * canonical carries type='web', foundation_source='web_verified', and NO
 * academic signals. Honest by construction — "a URL that had this content",
 * not "a legitimate authored work".
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('canonical_source', function (Blueprint $table) {
            $table->text('source_url')->nullable();
            $table->index('source_url');
        });
    }

    public function down(): void
    {
        Schema::table('canonical_source', function (Blueprint $table) {
            $table->dropIndex(['source_url']);
            $table->dropColumn('source_url');
        });
    }
};
