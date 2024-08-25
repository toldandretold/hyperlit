<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddDeletedAtToHighlightsTable extends Migration
{
    public function up()
    {
        Schema::table('highlights', function (Blueprint $table) {
            $table->softDeletes(); // Adds a deleted_at column
        });
    }

    public function down()
    {
        Schema::table('highlights', function (Blueprint $table) {
            $table->dropColumn('deleted_at');
        });
    }
}
