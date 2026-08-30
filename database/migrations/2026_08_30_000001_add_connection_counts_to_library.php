<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * The two halves of a book's docuverse-connectedness score, written by
     * App\Services\Hypercites\ConnectionCountQuery and ranked on by the
     * "Most Connected" / "Most Lit" feeds.
     *
     *  - hypercite_connections — minted hypercite edges, both directions
     *    (2 x distinct books quoting this one, + distinct books this one quotes).
     *  - reference_connections — bibliography/footnote references resolving to
     *    a book actually held here, same weighting. Docuverse links that exist
     *    but have not been minted into hypercites yet.
     *
     * Nullable, no default: NULL means "never computed" and is distinguishable
     * from a genuine 0. This replaces library.total_citations as the ranking
     * input — that column counted INBOUND hypercites only and was refreshed
     * solely for `listed = true` books, so it was permanently NULL for the
     * harvested journal corpus (which is minted listed = false).
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE library
            ADD COLUMN hypercite_connections integer NULL,
            ADD COLUMN reference_connections integer NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE library
            DROP COLUMN IF EXISTS hypercite_connections,
            DROP COLUMN IF EXISTS reference_connections
        ");
    }
};
