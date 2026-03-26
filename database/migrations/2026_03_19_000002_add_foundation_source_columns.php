<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->string('foundation_source')->nullable()->index();
        });

        Schema::table('library', function (Blueprint $table) {
            $table->string('foundation_source')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::table('bibliography', function (Blueprint $table) {
            $table->dropIndex(['foundation_source']);
            $table->dropColumn('foundation_source');
        });

        Schema::table('library', function (Blueprint $table) {
            $table->dropIndex(['foundation_source']);
            $table->dropColumn('foundation_source');
        });
    }
};
