<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * vector(768) fp32 → halfvec(768) fp16: halves the embedding column
     * (3,080 B → 1,544 B per node) AND the HNSW index (547 MB → ~280 MB in
     * prod), with negligible recall loss. Requires pgvector >= 0.7 (prod is
     * on 0.8.1, dev 0.8.2).
     *
     * NB: ALTER TYPE rewrites the whole nodes table under an ACCESS EXCLUSIVE
     * lock — a few minutes at prod size (~1.8 GB heap+TOAST). Run at a quiet
     * hour. The rewrite also compacts the table, so no VACUUM FULL needed
     * for this change.
     */
    public function up(): void
    {
        // The index must go first: ALTER TYPE tries to rebuild dependent
        // indexes with their existing opclass, and vector_cosine_ops is
        // invalid for halfvec.
        DB::statement('DROP INDEX IF EXISTS idx_nodes_embedding');
        DB::statement('ALTER TABLE nodes ALTER COLUMN embedding TYPE halfvec(768) USING embedding::halfvec(768)');
        DB::statement('CREATE INDEX IF NOT EXISTS idx_nodes_embedding ON nodes USING hnsw (embedding halfvec_cosine_ops)');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS idx_nodes_embedding');
        DB::statement('ALTER TABLE nodes ALTER COLUMN embedding TYPE vector(768) USING embedding::vector(768)');
        DB::statement('CREATE INDEX IF NOT EXISTS idx_nodes_embedding ON nodes USING hnsw (embedding vector_cosine_ops)');
    }
};
