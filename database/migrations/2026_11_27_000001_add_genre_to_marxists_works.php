<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * `genre`: what kind of writing the work is — book | article | letter | short_work — as
 * `App\Services\Marxists\MarxistsWorkClassifier` read it from the work's own page. The
 * `library.type` vocabulary is BibTeX's five (a letter has to be `misc` there), so the finer
 * answer is kept on the ledger, where "every letter Lenin wrote" is one query.
 * See docs/marxists-import.md §"What kind of work".
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement('ALTER TABLE marxists_works ADD COLUMN genre varchar(20)');
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('ALTER TABLE marxists_works DROP COLUMN IF EXISTS genre');
    }
};
