<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement('CREATE EXTENSION IF NOT EXISTS vector');
        DB::statement('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS embedding vector(768)');
        DB::statement('CREATE INDEX IF NOT EXISTS idx_nodes_embedding ON nodes USING hnsw (embedding vector_cosine_ops)');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS idx_nodes_embedding');
        DB::statement('ALTER TABLE nodes DROP COLUMN IF EXISTS embedding');
    }
};
