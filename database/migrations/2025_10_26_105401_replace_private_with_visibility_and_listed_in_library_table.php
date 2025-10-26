<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            // Add new columns
            $table->string('visibility', 20)->default('public');
            $table->boolean('listed')->default(true);
        });

        // Migrate existing data: private = true means unlisted (but still public/accessible)
        DB::table('library')->update([
            'listed' => DB::raw('NOT private'),
            'visibility' => 'public'
        ]);

        Schema::table('library', function (Blueprint $table) {
            // Drop old column
            $table->dropColumn('private');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            // Re-add private column
            $table->boolean('private')->default(false);
        });

        // Migrate data back: listed = false means private = true
        DB::table('library')->update([
            'private' => DB::raw('NOT listed')
        ]);

        Schema::table('library', function (Blueprint $table) {
            // Drop new columns
            $table->dropColumn(['visibility', 'listed']);
        });
    }
};
