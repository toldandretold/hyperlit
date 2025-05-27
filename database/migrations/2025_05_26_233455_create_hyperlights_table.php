<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('hyperlights', function (Blueprint $table) {
            $table->id();
            $table->string('book');
            $table->string('hyperlight_id');
            $table->text('annotation')->nullable();
            $table->integer('endChar')->nullable();
            $table->text('highlightedHTML')->nullable();
            $table->text('highlightedText')->nullable();
            $table->integer('startChar')->nullable();
            $table->string('startLine')->nullable();
            $table->jsonb('raw_json'); // Store the complete object
            $table->timestamps();

            // Composite unique key to match IndexedDB
            $table->unique(['book', 'hyperlight_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('hyperlights');
    }
};
