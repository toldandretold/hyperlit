<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * A chunk_id can be a DECIMAL (fractional indexing wedges a chunk between two others, e.g. 4.5).
 * `nodes.chunk_id` is already `double precision`, but `user_reading_positions.chunk_id` was
 * `integer`, so a scroll position saved inside a fractional chunk truncated (4.5 → 4) and resume
 * landed on the wrong chunk. Widen it to match `nodes.chunk_id` so bookmarks preserve the decimal.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE user_reading_positions ALTER COLUMN chunk_id TYPE double precision');
    }

    public function down(): void
    {
        // Round back to an integer on rollback (USING avoids a cast error on existing decimals).
        DB::statement('ALTER TABLE user_reading_positions ALTER COLUMN chunk_id TYPE integer USING ROUND(chunk_id)');
    }
};
