<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class RenameColumnsInHypercitesAndHyperciteLinks extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        // Rename columns in the hypercites table
        Schema::table('hypercites', function (Blueprint $table) {
            $table->renameColumn('href-a', 'href_a');
            $table->renameColumn('citation_id-a', 'citation_id_a');
        });

        // Rename columns in the hypercite_links table
        Schema::table('hypercite_links', function (Blueprint $table) {
            $table->renameColumn('href-b', 'href_b');
            $table->renameColumn('citation_id-b', 'citation_id_b');
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        // Revert column names in the hypercites table
        Schema::table('hypercites', function (Blueprint $table) {
            $table->renameColumn('href_a', 'href-a');
            $table->renameColumn('citation_id_a', 'citation_id-a');
        });

        // Revert column names in the hypercite_links table
        Schema::table('hypercite_links', function (Blueprint $table) {
            $table->renameColumn('href_b', 'href-b');
            $table->renameColumn('citation_id_b', 'citation_id-b');
        });
    }
}
