<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * How many works a JOURNAL-SCOPED run may attempt — the console's "import next N".
 *
 * The existing actions are all article-scoped, so `canonical_source_id` was the whole target and
 * no cap was needed. `enumerate` and `import_all` act on the journal instead (that column is
 * already nullable for exactly this case), and the cap is the operator's spend control: 0 means
 * "everything eligible", which is a real and deliberate choice but not one to make by default.
 *
 * Named `work_limit`, not `limit` — LIMIT is a reserved word, and a column that has to be quoted
 * in every hand-written query is a trap for the next person.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('journal_import_runs', function (Blueprint $table) {
            $table->integer('work_limit')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('journal_import_runs', function (Blueprint $table) {
            $table->dropColumn('work_limit');
        });
    }
};
