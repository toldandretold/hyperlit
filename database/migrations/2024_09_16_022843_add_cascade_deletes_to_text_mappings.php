<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class AddCascadeDeletesToTextMappings extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        // Drop the existing text_mappings table
        Schema::dropIfExists('text_mappings');

        // Recreate the table with the foreign key constraint and cascade on delete
        Schema::create('text_mappings', function (Blueprint $table) {
            $table->id(); // Primary key
            $table->foreignId('foreign_key_column')
                  ->constrained('other_table') // Adjust to your actual related table
                  ->onDelete('cascade'); // Cascade delete foreign key constraint
            $table->string('text')->nullable();
            $table->integer('start_position')->nullable();
            $table->integer('end_position')->nullable();
            // Add any other columns necessary for your table
            $table->timestamps(); // Add created_at and updated_at timestamps
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        // Drop the table in the reverse migration
        Schema::dropIfExists('text_mappings');
    }
}
