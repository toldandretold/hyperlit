<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Suggested edits: a highlight creator can propose replacement text for the
 * highlighted passage. suggested_text is a per-node map mirroring charData's
 * keys — { data-node-id: { before, after } } — where `before` snapshots the
 * span as it read at suggestion time (highlightedText is live-maintained, so
 * without the snapshot the original is lost on the next book edit) and `after`
 * is the proposed replacement. On E2EE books the column holds the __hlenc__
 * envelope. suggestion_status: null | pending | accepted | rejected | liked;
 * only the book owner's resolve endpoint may write the resolved states.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->jsonb('suggested_text')->nullable()->after('annotation');
            $table->string('suggestion_status', 16)->nullable()->after('suggested_text');
        });
    }

    public function down(): void
    {
        Schema::table('hyperlights', function (Blueprint $table) {
            $table->dropColumn(['suggested_text', 'suggestion_status']);
        });
    }
};
