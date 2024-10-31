<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateHypercitesTable extends Migration
{
    public function up()
    {
        Schema::create('hypercites', function (Blueprint $table) {
            $table->id();
            $table->string('citation_id');
            $table->string('hypercite_id');
            $table->string('hypercited_text');
            $table->timestamps();
        });
    }

    public function down()
    {
        Schema::dropIfExists('hypercites');
    }
}

