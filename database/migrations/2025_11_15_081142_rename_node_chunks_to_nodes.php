<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Renames the node_chunks table to nodes for better semantic clarity.
     * The term "chunks" is an implementation detail of lazy loading, not a domain concept.
     */
    public function up(): void
    {
        // Rename the table
        DB::statement('ALTER TABLE node_chunks RENAME TO nodes');

        // Rename the sequence
        DB::statement('ALTER SEQUENCE node_chunks_id_seq RENAME TO nodes_id_seq');

        // Rename the primary key constraint
        DB::statement('ALTER TABLE nodes RENAME CONSTRAINT node_chunks_pkey TO nodes_pkey');

        // Rename the unique constraint
        DB::statement('ALTER TABLE nodes RENAME CONSTRAINT node_chunks_node_id_unique TO nodes_node_id_unique');

        // Rename the index
        DB::statement('ALTER INDEX node_chunks_node_id_index RENAME TO nodes_node_id_index');
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        // Rename the index back
        DB::statement('ALTER INDEX nodes_node_id_index RENAME TO node_chunks_node_id_index');

        // Rename the unique constraint back
        DB::statement('ALTER TABLE nodes RENAME CONSTRAINT nodes_node_id_unique TO node_chunks_node_id_unique');

        // Rename the primary key constraint back
        DB::statement('ALTER TABLE nodes RENAME CONSTRAINT nodes_pkey TO node_chunks_pkey');

        // Rename the sequence back
        DB::statement('ALTER SEQUENCE nodes_id_seq RENAME TO node_chunks_id_seq');

        // Rename the table back
        DB::statement('ALTER TABLE nodes RENAME TO node_chunks');
    }
};
