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
        Schema::create('node_chunks', function (Blueprint $table) {
            $table->id();
            $table->jsonb('raw_json'); // The whole object as JSON

            // Individual fields for easy querying
            $table->string('book');
            $table->float('chunk_id');
            $table->float('startLine');
            $table->jsonb('footnotes')->nullable();
            $table->jsonb('hypercites')->nullable();
            $table->jsonb('hyperlights')->nullable();
            $table->text('content')->nullable();
            $table->text('plainText')->nullable();
            $table->string('type')->nullable();

            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('node_chunks');
    }
};
