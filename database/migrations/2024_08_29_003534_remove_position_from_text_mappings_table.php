<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class RemovePositionFromTextMappingsTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('text_mappings', function (Blueprint $table) {
            // Drop the 'position' column
            $table->dropColumn('position');
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('text_mappings', function (Blueprint $table) {
            // Add the 'position' column back
            $table->integer('position')->nullable();
        });
    }
}
