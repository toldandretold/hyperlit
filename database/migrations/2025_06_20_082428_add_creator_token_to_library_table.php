<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddCreatorTokenToLibraryTable extends Migration
{
    public function up()
    {
        Schema::table('library', function (Blueprint $table) {
            $table->uuid('creator_token')
                  ->nullable()
                  ->index();
        });
    }

    public function down()
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn('creator_token');
        });
    }
}