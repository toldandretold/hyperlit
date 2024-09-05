<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddXpathToTextMappingsTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('text_mappings', function (Blueprint $table) {
            // Add the 'xpath' column to the 'text_mappings' table
            $table->text('xpath')->nullable()->after('mapping_id');
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
            // Drop the 'xpath' column if the migration is rolled back
            $table->dropColumn('xpath');
        });
    }
}
