<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('citation_pipelines', function (Blueprint $table) {
            $table->jsonb('step_timings')->nullable()->after('step_detail');
        });
    }

    public function down(): void
    {
        Schema::table('citation_pipelines', function (Blueprint $table) {
            $table->dropColumn('step_timings');
        });
    }
};
