<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateTextFingerprintsTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
{
    Schema::create('text_fingerprints', function (Blueprint $table) {
        $table->id(); // Primary Key
        $table->string('hash')->unique(); // Unique hash column
        $table->text('text_segment'); // Text segment
        $table->foreignId('source_id')->constrained('highlights'); // Foreign key linking to highlights table
        $table->integer('position')->nullable(); // Position within the text, nullable
        $table->timestamps(); // created_at and updated_at
    });
}


    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::dropIfExists('text_fingerprints');
    }
}
