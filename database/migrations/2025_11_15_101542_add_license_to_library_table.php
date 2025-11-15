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
            $table->string('license', 100)->default('CC-BY-SA-4.0-NO-AI')->after('visibility');
            $table->text('custom_license_text')->nullable()->after('license');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn(['license', 'custom_license_text']);
        });
    }
};
