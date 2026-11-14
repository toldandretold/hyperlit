<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A work import may name a shelf to deliver onto — set when a shelf owner imports a cited
 * work from their hypercite workbench with "add to this shelf" on. The importer's
 * "Imported works" shelf is still filled as before; this is in addition.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('work_imports', function (Blueprint $table) {
            $table->uuid('shelf_id')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('work_imports', function (Blueprint $table) {
            $table->dropColumn('shelf_id');
        });
    }
};
