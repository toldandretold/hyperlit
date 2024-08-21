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
            $table->text('text'); // Column to store the highlighted text
            $table->string('highlight_id')->unique(); // Column to store the highlight ID
            $table->integer('numerical')->nullable(); // Column to store numerical metadata
            $table->timestamps(); // Columns to store created_at and updated_at timestamps
        });
    }

    public function down()
    {
        Schema::dropIfExists('highlights');
    }
}

