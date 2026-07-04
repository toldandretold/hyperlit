<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Opt-in E2EE flag + key blob on library (see docs/e2ee.md).
 *
 * `encrypted` marks a book whose content columns hold client-side ciphertext
 * (hlenc envelopes). It is SEPARATE from `visibility` — plain private books
 * stay server-readable; an encrypted book is additionally forced
 * private/unlisted/slug-less while the flag is set.
 *
 * `wrapped_dek` is the book's data-encryption key wrapped by the owner's
 * vault key (hlenc envelope) — present on top-level encrypted books only;
 * sub-books use their root book's DEK.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->boolean('encrypted')->default(false);
            $table->text('wrapped_dek')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('library', function (Blueprint $table) {
            $table->dropColumn(['encrypted', 'wrapped_dek']);
        });
    }
};
