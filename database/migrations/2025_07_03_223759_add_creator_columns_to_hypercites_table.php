<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->string('creator')->nullable()->after('raw_json');
            $table->uuid('creator_token')->nullable()->after('creator');
            $table->index('creator_token');
        });
    }

    public function down(): void
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropIndex(['creator_token']);
            $table->dropColumn(['creator', 'creator_token']);
        });
    }
};