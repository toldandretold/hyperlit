<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('references', function (Blueprint $table) {
            // We use a composite primary key to ensure each referenceId is unique per book.
            $table->string('book');
            $table->string('referenceId');
            $table->text('content'); // The HTML content of the reference
            $table->timestamps();

            $table->primary(['book', 'referenceId']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('references');
    }
};
