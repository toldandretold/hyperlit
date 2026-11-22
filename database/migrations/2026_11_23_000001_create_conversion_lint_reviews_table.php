<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A human's verdict on one conversion-lint finding (App\Services\Conversion\ConversionLint).
 *
 * A finding is "look here", not a verdict — this table is where the verdict goes once someone
 * has looked. `false_alarm` removes the finding from the lane's count for good; `real` marks it
 * confirmed, which is what picks the example case to download for a converter fix.
 *
 * Keyed by (book, key) where key = detector + excerpt hash (ConversionLint::key) — NOT a node id,
 * so a verdict survives a reconvert: a dismissed false alarm stays dismissed when the same text
 * comes back under new node ids, and a confirmed problem that the fix removed simply stops
 * matching anything. The detector and excerpt are stored alongside so the dismissed ones can be
 * read back as evidence for tightening a detector, without the book.
 *
 * Operator-only, like the other conversion_lint_* tables: pgsql_admin, no RLS.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('conversion_lint_reviews', function (Blueprint $table) {
            $table->string('book');
            $table->string('key', 80);
            $table->string('verdict', 16);                 // real | false_alarm
            $table->string('detector', 40);
            $table->text('excerpt');
            $table->string('start_line')->nullable();      // where it sat when reviewed (informational)
            $table->string('reviewed_by')->nullable();
            $table->timestamp('reviewed_at');
            $table->primary(['book', 'key']);
            $table->index('verdict');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conversion_lint_reviews');
    }
};
