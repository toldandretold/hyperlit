<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('hypercites', function (Blueprint $table) {
            $table->id();
            $table->string('book');
            $table->string('hyperciteId');
            $table->jsonb('citedIN')->nullable(); // Store array as JSON
            $table->integer('endChar')->nullable();
            $table->text('hypercitedHTML')->nullable();
            $table->text('hypercitedText')->nullable();
            $table->string('relationshipStatus')->nullable();
            $table->integer('startChar')->nullable();
            $table->jsonb('raw_json'); // Store the complete object
            $table->timestamps();

            // Composite unique key to match IndexedDB
            $table->unique(['book', 'hyperciteId']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('hypercites');
    }
};
