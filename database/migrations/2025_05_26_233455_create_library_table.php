<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('library', function (Blueprint $table) {
            $table->string('book')->primary(); // Primary key
            $table->string('author')->nullable();
            $table->text('bibtex')->nullable();
            $table->string('citationID')->nullable();
            $table->string('fileName')->nullable();
            $table->string('fileType')->nullable();
            $table->string('journal')->nullable();
            $table->text('note')->nullable();
            $table->string('pages')->nullable();
            $table->string('publisher')->nullable();
            $table->string('school')->nullable();
            $table->timestamp('timestamp')->nullable();
            $table->string('title')->nullable();
            $table->string('type')->nullable();
            $table->string('url')->nullable();
            $table->string('year')->nullable();
            $table->jsonb('raw_json'); // Store the complete object
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('library');
    }
};
