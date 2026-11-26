<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A conversion-lint snapshot belongs to a SCOPE, not specifically to a journal.
 *
 * The before/after comparison around a corpus reconvert was built for /maintainer/journal-import
 * and keyed by `journal_source_id`, which left /maintainer/shelf-import — the same console over a
 * shelf, with the same "reconvert all" — unable to say what a reconvert fixed or broke. The key is
 * now the id of an App\Services\Conversion\ImportConsoleScope: a journal's id or a shelf's. Both
 * are uuids, so the column keeps its type and every existing row stays valid as it is.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('conversion_lint_snapshots', function (Blueprint $table) {
            $table->renameColumn('journal_source_id', 'scope_id');
        });
    }

    public function down(): void
    {
        Schema::table('conversion_lint_snapshots', function (Blueprint $table) {
            $table->renameColumn('scope_id', 'journal_source_id');
        });
    }
};
