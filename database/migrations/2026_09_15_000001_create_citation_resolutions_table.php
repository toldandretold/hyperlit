<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Human answers to the pipeline's AMBIGUOUS citation resolutions.
 *
 * When the antecedent walk-back finds more than one bibliography entry that fits a bare-year
 * citation, the converter links the best candidate but stamps the anchor
 * `data-resolved="ambiguous"` + `data-candidates="a|b"` — it stores a QUESTION. This table stores
 * the ANSWER, and it lives OUTSIDE the node HTML on purpose: the corpus is reconverted every time
 * the pipeline improves, and an answer written into content would be destroyed by the next sweep.
 * AmbiguousCitationRegistry re-applies resolved rows onto the fresh nodes after every reconvert —
 * the same survive-the-reconvert pattern as hyperlight reattachment and the hypercite
 * ResolutionSnapshotService.
 *
 * The row key is a FINGERPRINT of the citation, not a node id: node ids are minted fresh on every
 * reconvert. sha1(book | year | folded sentence head) is stable as long as the sentence itself is
 * — and when a pipeline fix changes the sentence text, the honest outcome is exactly what happens:
 * the old row no longer matches, the citation surfaces as pending again, and a human re-answers.
 *
 * `chosen` semantics: a bibliography anchor id = "this entry"; NULL with status=resolved = "not a
 * citation at all" (the anchor is unlinked back to plain text). status=pending = nobody has
 * answered yet — what /maintainer/citations lists.
 *
 * Admin-only operational data, accessed exclusively via pgsql_admin (no RLS policies — a
 * default-connection read returns nothing, which is correct: readers never query this).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('citation_resolutions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->text('book')->index();
            $table->string('fingerprint', 40);
            $table->string('year', 8);
            $table->text('sentence');                 // what the maintainer reads to decide
            $table->jsonb('candidates');              // ranked target ids as emitted, enriched at sync
            $table->text('href_current');             // where the interim guess points today
            $table->text('chosen')->nullable();       // resolved: entry id, or NULL = not a citation
            $table->string('status', 16)->default('pending')->index();  // pending | resolved
            $table->text('resolved_by')->nullable();
            $table->timestampTz('resolved_at')->nullable();
            $table->timestampsTz();
            $table->unique(['book', 'fingerprint']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('citation_resolutions');
    }
};
