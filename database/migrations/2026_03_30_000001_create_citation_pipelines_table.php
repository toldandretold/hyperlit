<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('citation_pipelines', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('book')->index();
            $table->string('status', 20)->default('pending');  // pending, running, completed, failed
            $table->string('current_step', 30)->nullable();     // bibliography, content, vacuum, ocr, review
            $table->text('step_detail')->nullable();             // e.g. "Fetching source 3/12"
            $table->text('error')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('citation_pipelines');
    }
};
