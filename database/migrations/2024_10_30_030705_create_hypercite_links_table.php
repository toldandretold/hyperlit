<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateHyperciteLinksTable extends Migration
{
    public function up()
    {
        Schema::create('hypercite_links', function (Blueprint $table) {
            $table->id();
            $table->string('hypercite_id');
            $table->string('hypercite_id_x'); // Foreign key from hypercites table
            $table->string('citation_id');     // Foreign key for reference
            $table->string('href');            // URL link
            $table->timestamps();
        });
    }

    public function down()
    {
        Schema::dropIfExists('hypercite_links');
    }
}
