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
        // Drop the old table to replace it with the new, correct schema.
        Schema::dropIfExists('footnotes');

        // Recreate it with a structure that holds one row per footnote.
        Schema::create('footnotes', function (Blueprint $table) {
            $table->string('book');
            $table->string('footnoteId'); // The unique ID for the footnote (e.g., "1", "2")
            $table->text('content');    // The text content of the footnote
            $table->timestamps();

            $table->primary(['book', 'footnoteId']);
        });
    }

    /**
     * Reverse the migrations.
     * (This would recreate the old, incorrect structure if you rollback)
     */
    public function down(): void
    {
        Schema::dropIfExists('footnotes');
        // Optional: You could add the old schema back here if you need a perfect rollback.
    }
};