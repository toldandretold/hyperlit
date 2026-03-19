<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->string('open_library_key', 50)->nullable()->after('openalex_id');
        });

        Schema::table('library', function (Blueprint $table) {
            $table->index('open_library_key');
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropIndex(['open_library_key']);
            $table->dropColumn('open_library_key');
        });
    }
};
