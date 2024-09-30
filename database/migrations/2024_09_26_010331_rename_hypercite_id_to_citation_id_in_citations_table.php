<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class RenameHyperciteIdToCitationIdInCitationsTable extends Migration
{
    public function up()
    {
        Schema::table('citations', function (Blueprint $table) {
            $table->renameColumn('hypercite_id', 'citation_id');
        });
    }

    public function down()
    {
        Schema::table('citations', function (Blueprint $table) {
            $table->renameColumn('citation_id', 'hypercite_id');
        });
    }
}
