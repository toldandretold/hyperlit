<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Licences that LINK somewhere, not just a code.
 *
 *  - license_url      An upstream terms page for a licence our vocabulary has no deed for
 *                     (a publisher's own licence URL, a repository's licence handle). Before
 *                     this, such a URL was stored SHOUTED in custom_license_text as plain text.
 *  - license_book     A custom licence is a BOOK owned by the work's creator (the
 *                     /license2025content pattern): readers get a real page, and the owner can
 *                     reuse it across all their works. Holds that book's id.
 *  - license_book_at  ms timestamp at which the licence book's terms were applied to THIS work.
 *                     A work stays under the terms as they read then — if the licence book is
 *                     edited later, the work links to /{book}/timemachine?at=<this>.
 *                     custom_license_text stays as a plain-text snapshot fallback.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->text('license_url')->nullable()->after('custom_license_text');
            $table->string('license_book', 255)->nullable()->after('license_url');
            $table->bigInteger('license_book_at')->nullable()->after('license_book');
        });

        // "Which works use this licence book" (deletion warning, apply-to-all, the picker's
        // "your licences" list). Partial: almost every row is NULL.
        DB::statement('CREATE INDEX IF NOT EXISTS library_license_book_idx ON library (license_book) WHERE license_book IS NOT NULL');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS library_license_book_idx');
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn(['license_url', 'license_book', 'license_book_at']);
        });
    }
};
