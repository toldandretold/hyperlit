<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class UpdateHighlightsTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('highlights', function (Blueprint $table) {
            // Modify columns as needed
            $table->string('highlight_id')->nullable()->change();
            $table->dropColumn('instance_order'); // Remove if not needed
            $table->integer('start_position')->nullable();
            $table->integer('end_position')->nullable();
            $table->string('context_hash')->nullable();
            $table->dropColumn('numerical'); // Remove if not needed, replace with start and end positions
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('highlights', function (Blueprint $table) {
            // Reverse changes if needed
            $table->dropColumn('start_position');
            $table->dropColumn('end_position');
            $table->dropColumn('context_hash');
            $table->integer('numerical')->nullable();
            $table->string('instance_order')->nullable();
        });
    }
}
