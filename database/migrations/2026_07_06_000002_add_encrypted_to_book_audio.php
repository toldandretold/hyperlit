<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * E2EE (docs/e2ee.md): TTS MP3s are spoken plaintext of the book, so the lock
 * pass encrypts them in place like image blobs (HLENC1 envelope). This flag
 * mirrors book_images.encrypted — flipped by BookAudioStore::replaceBytes.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement(
            'ALTER TABLE book_audio ADD COLUMN encrypted boolean NOT NULL DEFAULT false'
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('ALTER TABLE book_audio DROP COLUMN encrypted');
    }
};
