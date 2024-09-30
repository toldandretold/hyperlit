<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateCitationsTable extends Migration
{
    public function up()
    {
        Schema::create('citations', function (Blueprint $table) {
            $table->id();  // This creates the auto-incrementing 'id' column
            $table->string('bibtex')->nullable();
            $table->string('type')->nullable();
            $table->string('hypercite_id')->nullable();  // Renamed to 'hypercite_id'
            $table->string('author')->nullable();
            $table->string('title')->nullable();
            $table->string('year')->nullable();
            $table->string('url')->nullable();
            $table->string('pages')->nullable();
            $table->string('journal')->nullable();
            $table->string('publisher')->nullable();
            $table->string('school')->nullable();
            $table->string('note')->nullable();
            $table->string('location')->nullable();
            $table->timestamps();  // Adds 'created_at' and 'updated_at' columns
        });
    }

    public function down()
    {
        Schema::dropIfExists('citations');
    }
}
