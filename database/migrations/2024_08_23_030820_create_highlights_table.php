<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateHighlightsTable extends Migration
{
    public function up()
    {
        Schema::create('highlights', function (Blueprint $table) {
            $table->id();
            $table->string('highlight_id')->unique();
            $table->text('text');
            $table->string('book');
            $table->integer('numerical');
            $table->timestamps();
        });
    }

    public function down()
    {
        Schema::dropIfExists('highlights');
    }
}
