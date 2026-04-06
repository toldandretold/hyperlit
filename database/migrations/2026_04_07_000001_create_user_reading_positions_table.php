<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_reading_positions', function (Blueprint $table) {
            $table->id();
            $table->string('book');
            $table->string('user_name')->nullable();
            $table->string('anon_token')->nullable();
            $table->integer('chunk_id')->default(0);
            $table->string('element_id')->nullable();
            $table->timestamp('updated_at')->useCurrent();

            $table->unique(['book', 'user_name']);
            $table->unique(['book', 'anon_token']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_reading_positions');
    }
};
