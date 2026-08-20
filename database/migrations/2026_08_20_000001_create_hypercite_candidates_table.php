<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Candidate hypercites detected from a collection's citation graph: article A cites work B
 * we also hold, at a specific in-text marker, possibly with a direct quote whose location
 * in B has been attempted. The /maintainer/hypercites console reviews these; approving one
 * mints a real `hypercites` row and splices the citing-side anchor.
 *
 * A detection SCOPE is either a journal (journal_source_id) or a public shelf (shelf_id) —
 * exactly one is set. Shelves reuse the whole pipeline: their items are the citing books,
 * and `is_internal` means "the cited work is also in this collection".
 *
 * REBUILDABLE CACHE semantics: every column is re-derivable from the two books' content,
 * so detection upserts on the stable key (citing_book, reference_id, occurrence_index) —
 * stable across reconverts because it names the citation, not a node id. The exceptions
 * that must survive a re-run are the HUMAN verdicts: `rejected` rows are kept (they are
 * labeled data for the future auto-approve model) and `applied` rows are kept unless the
 * citing node's content hash no longer matches (a reconvert rewrote the splice site) —
 * then they flip back to pending for re-confirmation.
 *
 * `citing_content_hash` / `cited_content_hash` are the stale guards: minting refuses when
 * the live node content no longer matches what detection measured, because the stored
 * char offsets would land the hypercite on the wrong text.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('hypercite_candidates', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('journal_source_id')->nullable()->index(); // scope: journal…
            $table->uuid('shelf_id')->nullable()->index();          // …or public shelf (exactly one set)
            $table->uuid('citing_canonical_source_id')->nullable()->index(); // shelf books may be canonical-less
            $table->uuid('cited_canonical_source_id')->index();
            $table->string('citing_book');           // best readable version at detection time
            $table->string('cited_book');
            $table->boolean('is_internal')->default(false); // cited work is in the same collection

            $table->string('reference_id');          // bibliography.referenceId in the citing book
            $table->smallInteger('occurrence_index'); // nth NODE carrying that refId, startLine order
            $table->unique(['citing_book', 'reference_id', 'occurrence_index'], 'hc_candidates_stable_key');

            // Citing side (plainText coordinates, entities decoded — the client's textContent space)
            $table->string('citing_node_id');
            $table->integer('marker_offset');         // char offset of the citation marker
            $table->integer('claim_start')->nullable();
            $table->integer('claim_end')->nullable();
            $table->boolean('has_quote')->default(false);
            $table->string('quote_kind', 20)->nullable();  // inline | blockquote
            $table->text('quote_text')->nullable();
            $table->string('quote_node_id')->nullable();   // differs from citing_node_id for blockquotes
            $table->string('citing_content_hash', 64);     // sha1(nodes.content) at detection

            // Cited side (filled when the quote was located)
            $table->jsonb('match_node_ids')->nullable();   // ordered node ids the quote spans
            $table->jsonb('match_char_data')->nullable();  // {nodeId: {charStart, charEnd}} — hypercites.charData shape
            $table->string('match_method', 20)->nullable();   // exact | normalized | fts_fuzzy
            $table->float('match_score')->nullable();         // 1.0 exact … fuzzy ratio
            $table->smallInteger('match_occurrences')->nullable(); // >1 = ambiguous, blocks auto-approve
            $table->string('cited_content_hash', 64)->nullable();

            // Lifecycle
            $table->string('status', 20)->default('pending')->index();
            // pending (no quote / awaiting) | matched | no_match | rejected | applied | failed
            $table->string('hypercite_id')->nullable();    // set on apply
            $table->unsignedBigInteger('reviewed_by')->nullable();
            $table->timestampTz('reviewed_at')->nullable();
            $table->timestampTz('applied_at')->nullable();
            $table->boolean('auto_approved')->default(false);
            $table->text('error')->nullable();
            $table->uuid('detection_run_id')->nullable();
            $table->timestamps();

            $table->index(['journal_source_id', 'status']);
            $table->index(['shelf_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('hypercite_candidates');
    }
};
