<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Marks a hypercite run as started from the SHELF-OWNER workbench (/a/{slug}/hypercites)
 * rather than the admin console.
 *
 * The run row is all a queued job carries, so the trust boundary has to live on it. A
 * `billed` detect run (a) charges `user_id` the metered LLM cost of every bibliography scan
 * it performs — an admin run stays unbilled, the platform's own corpus work — and (b) walks
 * only the shelf books that user is allowed to have scanned (public ones and their own),
 * where an admin run walks the whole shelf.
 *
 * Deliberately NOT inferred from "user_id is not an admin": an admin using the owner
 * workbench on their own shelf should get exactly what an owner gets, and a flag that flips
 * with someone's role would re-price a run that is already half done.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hypercite_runs', function (Blueprint $table) {
            $table->boolean('billed')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('hypercite_runs', function (Blueprint $table) {
            $table->dropColumn('billed');
        });
    }
};
