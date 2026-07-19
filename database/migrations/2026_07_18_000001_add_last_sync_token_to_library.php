<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Lost-ACK self-conflict detection for the unified sync (the "Book out of date"
     * overlay firing on a mere network blip).
     *
     * Every unified-sync POST now carries a client-generated `sync_token`; when the
     * sync writes the library row (i.e. advances the book's `timestamp`), the token is
     * stored here. A later STALE_DATA 409 echoes it back as `server_sync_token`, so the
     * client can prove "the server's current version is MY OWN committed write whose
     * response was lost" and silently fast-forward + retry — even when local edits kept
     * changing the content after the lost write, which defeats the content-compare
     * fallback (resources/js/indexedDB/syncQueue/selfConflictContentCheck.ts).
     *
     * See UnifiedSyncController and resources/js/indexedDB/syncQueue/sentSyncTokens.ts.
     */
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            if (!Schema::hasColumn('library', 'last_sync_token')) {
                $table->string('last_sync_token', 64)->nullable();
            }
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            if (Schema::hasColumn('library', 'last_sync_token')) {
                $table->dropColumn('last_sync_token');
            }
        });
    }
};
