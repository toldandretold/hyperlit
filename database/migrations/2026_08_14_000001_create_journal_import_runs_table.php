<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * State for the actions the journal-import console fires: importing a work's lanes, and
 * re-running the HTML lane over an article that already has one.
 *
 * The console was read-only + promote; every actual import ran from the CLI. But the fix loop it
 * exists to serve is "spot a bad conversion on prod → bundle it → fix the processor locally →
 * reconvert on prod", and that last step needs a button. These actions fetch, OCR and cost money,
 * so they run on the queue (`citation-pipeline`, alongside the source harvester) rather than in a
 * request, and this row is what the page polls.
 *
 * Article-scoped by design: `canonical_source_id` names ONE work. The journal-wide "import the
 * next N" run is the same shape with that column null, which is why it is nullable.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('journal_import_runs', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('journal_source_id')->index();
            $table->uuid('canonical_source_id')->nullable()->index();  // null = whole-journal run
            $table->unsignedBigInteger('user_id')->nullable();         // who pays for OCR
            $table->string('action', 20);                              // import, reconvert_html, refetch_html
            $table->string('lanes', 10)->default('both');              // pdf, html, both
            $table->string('status', 20)->default('pending');          // pending, running, completed, failed
            $table->string('book')->nullable();                        // the lane acted on / produced
            $table->text('step_detail')->nullable();
            $table->jsonb('counts')->default('{}');
            $table->text('error')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('journal_import_runs');
    }
};
