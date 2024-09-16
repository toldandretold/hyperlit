<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddXpathFullAndNotesToHighlightsTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('highlights', function (Blueprint $table) {
            // Add the xpath_full and notes columns
            $table->string('xpath_full')->nullable()->after('start_xpath'); // Adding after start_xpath for better order
            $table->text('notes')->nullable()->after('end_position'); // Adding notes after the positions
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
            // Drop the xpath_full and notes columns
            $table->dropColumn('xpath_full');
            $table->dropColumn('notes');
        });
    }
}
