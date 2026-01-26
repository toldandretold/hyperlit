<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Make the startLine unique constraint deferrable.
     *
     * This allows bulk updates (like renumbering) to temporarily have duplicate
     * startLines during the transaction, with uniqueness enforced at commit.
     */
    public function up(): void
    {
        // Drop the existing unique index
        DB::statement('DROP INDEX IF EXISTS nodes_book_startline_unique');

        // Recreate as a deferrable unique constraint
        // DEFERRABLE INITIALLY DEFERRED = check at transaction commit, not per-statement
        DB::statement('
            ALTER TABLE nodes
            ADD CONSTRAINT nodes_book_startline_unique
            UNIQUE (book, "startLine")
            DEFERRABLE INITIALLY DEFERRED
        ');
    }

    /**
     * Reverse the migration.
     */
    public function down(): void
    {
        // Drop the deferrable constraint
        DB::statement('ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_book_startline_unique');

        // Recreate as a regular unique index
        DB::statement('
            CREATE UNIQUE INDEX nodes_book_startline_unique
            ON nodes (book, "startLine")
        ');
    }
};
