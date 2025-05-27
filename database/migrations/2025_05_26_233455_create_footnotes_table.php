<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('footnotes', function (Blueprint $table) {
            $table->string('book')->primary(); // Primary key
            $table->jsonb('data'); // Store the array of footnotes as JSON
            $table->jsonb('raw_json'); // Store the complete object
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('footnotes');
    }
};
