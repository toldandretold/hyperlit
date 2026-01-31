<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->string('volume', 255)->nullable()->after('school');
            $table->string('issue', 255)->nullable()->after('volume');
            $table->string('booktitle', 255)->nullable()->after('issue');
            $table->string('chapter', 255)->nullable()->after('booktitle');
            $table->string('editor', 255)->nullable()->after('chapter');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn(['volume', 'issue', 'booktitle', 'chapter', 'editor']);
        });
    }
};
