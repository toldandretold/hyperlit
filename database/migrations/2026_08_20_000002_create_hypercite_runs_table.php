<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * State for the async actions the /maintainer/hypercites console fires: `detect` (walk a
 * journal's citation graph and build hypercite_candidates rows) and `import_source` (fetch
 * one most-cited external OA work via AutoVersionCreator so future detections can match
 * against it). Same shape and polling contract as `journal_import_runs` — a deliberately
 * separate table because that one's collision semantics are scoped to the import console's
 * actions and entangling two consoles on one row shape has bitten before.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('hypercite_runs', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuid('journal_source_id')->nullable()->index();   // scope: journal…
            $table->uuid('shelf_id')->nullable()->index();            // …or public shelf (exactly one set)
            $table->uuid('canonical_source_id')->nullable()->index(); // import_source target; null = scope-wide detect
            $table->unsignedBigInteger('user_id')->nullable();        // who pays for OCR on import_source
            $table->string('action', 20);                             // detect, import_source
            $table->string('status', 20)->default('pending');         // pending, running, completed, failed
            $table->text('step_detail')->nullable();
            $table->jsonb('counts')->default('{}');
            $table->text('error')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('hypercite_runs');
    }
};
