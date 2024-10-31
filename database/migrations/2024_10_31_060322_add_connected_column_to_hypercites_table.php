<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddConnectedColumnToHypercitesTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->unsignedTinyInteger('connected')->default(0); // Numerical with default 0
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->dropColumn('connected');
        });
    }
}
