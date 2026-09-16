<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * `library.creator` had no index, so "every book this user created" was a
 * sequential scan of the WHOLE library table — 239k rows on dev, with ~77k
 * rows discarded per parallel worker, to return one creator's 6.7k books. The
 * creator stats panel runs exactly that query on every open, and its cost
 * scaled with the size of the corpus rather than with the size of the user's
 * own shelf of work.
 *
 * PARTIAL, and that is the whole point — a plain index on `creator` is useless
 * here and was measured to be so. `library` is dominated by SUB-books: for the
 * heaviest dev creator, `creator = ?` matches 231,591 of the table's 239,114
 * rows, of which only 6,669 are root books. A plain index therefore selects
 * ~97% of the table and the planner correctly ignores it in favour of a seq
 * scan (bitmap-index path measured SLOWER: 81ms vs 34ms).
 *
 * Restricting the index to the root/not-deleted predicate the stats query
 * carries shrinks it to the rows anyone actually lists, so `creator = ?`
 * becomes selective. Postgres will use a partial index for any query whose
 * WHERE implies the predicate — keep those two conditions spelled the same way
 * at the call site or the index is silently skipped.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS library_creator_idx');

        DB::connection('pgsql_admin')->statement(
            "CREATE INDEX IF NOT EXISTS library_creator_root_idx ON library (creator)
             WHERE book NOT LIKE '%/%' AND COALESCE(visibility, 'public') <> 'deleted'"
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP INDEX IF EXISTS library_creator_root_idx');
    }
};
