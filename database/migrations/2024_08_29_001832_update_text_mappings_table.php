<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class UpdateTextMappingsTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('text_mappings', function (Blueprint $table) {
            // Add new columns for start and end positions in both HTML and Markdown
            $table->integer('start_position_html')->nullable();
            $table->integer('end_position_html')->nullable();
            $table->integer('start_position_markdown')->nullable();
            $table->integer('end_position_markdown')->nullable();
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
            // Reverse the changes by dropping the columns
            $table->dropColumn('start_position_html');
            $table->dropColumn('end_position_html');
            $table->dropColumn('start_position_markdown');
            $table->dropColumn('end_position_markdown');
        });
    }
}
