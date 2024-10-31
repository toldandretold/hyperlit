<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddHrefToHypercitesTable extends Migration
{
    public function up()
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->string('href')->nullable()->after('hypercited_text');
        });
    }

    public function down()
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropColumn('href');
        });
    }
}

