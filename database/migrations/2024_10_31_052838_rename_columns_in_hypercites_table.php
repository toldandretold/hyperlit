<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class RenameColumnsInHypercitesTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('hypercites', function (Blueprint $table) {
            $table->renameColumn('href', 'href-a');
            $table->renameColumn('citation_id', 'citation_id-a');
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
            $table->renameColumn('href-a', 'href');
            $table->renameColumn('citation_id-a', 'citation_id');
        });
    }
}

