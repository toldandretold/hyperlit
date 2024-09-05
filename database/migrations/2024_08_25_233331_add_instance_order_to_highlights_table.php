<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddInstanceOrderToHighlightsTable extends Migration
{
    public function up()
    {
        Schema::table('highlights', function (Blueprint $table) {
            $table->integer('instance_order')->nullable()->after('numerical');
        });
    }

    public function down()
    {
        Schema::table('highlights', function (Blueprint $table) {
            $table->dropColumn('instance_order');
        });
    }
}
