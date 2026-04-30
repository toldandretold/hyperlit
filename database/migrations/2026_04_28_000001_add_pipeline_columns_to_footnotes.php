<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('footnotes', function (Blueprint $table) {
            $table->boolean('is_citation')->default(false)->after('preview_nodes');
            $table->string('source_id')->nullable()->after('is_citation');
            $table->string('foundation_source')->nullable()->after('source_id');
            $table->jsonb('llm_metadata')->nullable()->after('foundation_source');
            $table->string('match_method', 50)->nullable()->after('llm_metadata');
            $table->float('match_score')->nullable()->after('match_method');
            $table->json('match_diagnostics')->nullable()->after('match_score');
        });
    }

    public function down(): void
    {
        Schema::table('footnotes', function (Blueprint $table) {
            $table->dropColumn([
                'is_citation',
                'source_id',
                'foundation_source',
                'llm_metadata',
                'match_method',
                'match_score',
                'match_diagnostics',
            ]);
        });
    }
};
