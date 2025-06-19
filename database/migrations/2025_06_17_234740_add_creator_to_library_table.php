<?php

use Illuminate\Support\Facades\Schema;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\Migrations\Migration;

class AddCreatorToLibraryTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('library', function (Blueprint $table) {
            // add a nullable string column 'creator' after total_highlights
            $table->string('creator')
                  ->nullable()
                  ->after('total_highlights');
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn('creator');
        });
    }
}