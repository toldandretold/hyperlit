<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class UpdateYearAndBibtexInCitationsTable extends Migration
{
    public function up()
    {
        Schema::table('citations', function (Blueprint $table) {
            $table->text('bibtex')->nullable()->change();  // Change 'bibtex' to text
            $table->integer('year')->nullable()->change();  // Change 'year' to integer
        });
    }

    public function down()
    {
        Schema::table('citations', function (Blueprint $table) {
            $table->string('bibtex')->nullable()->change();  // Revert 'bibtex' back to string
            $table->string('year')->nullable()->change();    // Revert 'year' back to string
        });
    }
}
