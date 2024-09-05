<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateTextMappingsTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::create('text_mappings', function (Blueprint $table) {
            $table->id();
            $table->string('book');
            $table->text('markdown_text');
            $table->text('html_text');
            $table->integer('position');
            $table->string('context_hash')->nullable();
            $table->string('mapping_id')->nullable();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::dropIfExists('text_mappings');
    }
}
