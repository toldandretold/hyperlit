<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per single-work import: a user (web URL importer or MCP `import_document`) handing
 * over a DOI / OpenAlex id for the open-access acquisition ladder to fetch. The row is the
 * job's state — who asked, which canonical, whether an OCR charge has been confirmed, and how
 * it ended (`commons` = the shared system copy, `personal_copy` = a private copy of a work we
 * may not host publicly). Same shape and worker-only access as `hypercite_runs`: read and
 * written through pgsql_admin, never by a client.
 *
 * `id` is the caller's requested book id, so the existing `/api/import-progress/{id}` poll and
 * MCP `import_status` follow a work import with no new endpoint.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('work_imports', function (Blueprint $table) {
            $table->string('id', 120)->primary();
            $table->unsignedBigInteger('user_id')->nullable()->index();  // who pays for OCR; null = anonymous session
            $table->string('creator')->nullable();                       // owner of a personal copy, if one is made
            $table->string('creator_token')->nullable();
            $table->uuid('canonical_source_id')->index();
            $table->string('identifier', 300);                           // "doi:10.…" / "openalex:W…"
            $table->string('surface', 8);                                // web | mcp
            $table->string('status', 24)->default('queued');             // queued, running, awaiting_confirmation, completed, failed
            $table->boolean('ocr_confirmed')->default(false);            // mcp: the user has accepted the OCR estimate
            $table->string('confirm_token', 40)->nullable();
            $table->string('system_book')->nullable();                   // the system version the ladder filled
            $table->string('book')->nullable();                          // what the importer is handed
            $table->string('outcome', 24)->nullable();                   // commons | personal_copy
            $table->text('reason')->nullable();
            $table->string('via')->nullable();
            $table->jsonb('estimate')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('work_imports');
    }
};
