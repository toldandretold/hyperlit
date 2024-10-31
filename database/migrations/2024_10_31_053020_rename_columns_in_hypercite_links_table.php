<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class RenameColumnsInHyperciteLinksTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::table('hypercite_links', function (Blueprint $table) {
            $table->renameColumn('href', 'href-b');
            $table->renameColumn('citation_id', 'citation_id-b');
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('hypercite_links', function (Blueprint $table) {
            $table->renameColumn('href-b', 'href');
            $table->renameColumn('citation_id-b', 'citation_id');
        });
    }
}
