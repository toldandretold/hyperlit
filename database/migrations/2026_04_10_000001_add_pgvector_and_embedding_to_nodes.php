<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Enable pgvector extension
        DB::statement('CREATE EXTENSION IF NOT EXISTS vector');

        // Add embedding column (768 dimensions for nomic-embed-text-v1.5)
        DB::statement('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS embedding vector(768)');

        // Create an HNSW index for fast cosine similarity search
        DB::statement('CREATE INDEX IF NOT EXISTS nodes_embedding_idx ON nodes USING hnsw (embedding vector_cosine_ops)');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS nodes_embedding_idx');
        DB::statement('ALTER TABLE nodes DROP COLUMN IF EXISTS embedding');
        // Don't drop the extension — other tables may use it
    }
};
