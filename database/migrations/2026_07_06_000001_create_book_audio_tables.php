<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Per-node TTS audio store. One row per (book, node_id): the synthesized MP3
 * for that node's plainText. Bytes live on the private `book_audio` disk
 * (storage/app/books/{book}/audio/), served only through the RLS-gated audio
 * route. `source_hash` = sha256 of the exact plainText fed to the TTS model —
 * staleness is COMPUTED (hash compare at manifest time), never stored, so
 * nuclear node upserts that rewrite rows without content change cause no
 * false invalidations. RLS mirrors book_images (join `library` on book).
 *
 * book_audio_meta: one row per book — pins the voice (regens must match the
 * original narration) and records who first paid for generation.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE book_audio (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                book varchar(255) NOT NULL,          -- ROOT book id (sub-books excluded from TTS)
                node_id varchar(255) NOT NULL,       -- stable data-node-id (nodes.node_id)
                filename varchar(255) NOT NULL,      -- {node_id}-{hash8}.mp3
                source_hash char(64) NOT NULL,       -- sha256 of the plainText synthesized
                voice varchar(64) NOT NULL,
                chars integer NOT NULL DEFAULT 0,    -- billed character count
                duration_ms integer NULL,            -- estimated from CBR bitrate
                bytes bigint NOT NULL DEFAULT 0,
                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW(),
                CONSTRAINT book_audio_book_node_unique UNIQUE (book, node_id)
            )
        ");

        DB::connection('pgsql_admin')->statement('CREATE INDEX book_audio_book_idx ON book_audio (book)');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE book_audio_meta (
                book varchar(255) PRIMARY KEY,
                voice varchar(64) NOT NULL,          -- pinned per book so regens stay consistent
                total_chars integer NOT NULL DEFAULT 0,
                generated_by varchar(255) NULL,      -- username of the first requester
                generated_at timestamp NULL,
                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");

        foreach (['book_audio', 'book_audio_meta'] as $table) {
            DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON {$table} TO {$appUser}");
            DB::connection('pgsql_admin')->statement("ALTER TABLE {$table} ENABLE ROW LEVEL SECURITY");
            DB::connection('pgsql_admin')->statement("ALTER TABLE {$table} FORCE ROW LEVEL SECURITY");

            // SELECT: visible if the owning book is public, or owned by the caller.
            // Mirrors book_images_select_policy.
            DB::connection('pgsql_admin')->statement("
                CREATE POLICY {$table}_select_policy ON {$table} FOR SELECT
                USING (EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = {$table}.book
                    AND (
                        library.visibility = 'public'
                        OR EXISTS (SELECT 1 FROM users WHERE users.name = library.creator
                                   AND users.user_token::text = current_setting('app.current_token', true))
                        OR (library.creator IS NULL AND library.creator_token IS NOT NULL
                            AND library.creator_token::text = current_setting('app.current_token', true))
                    )
                ))
            ");

            // INSERT/UPDATE/DELETE: owner only (drop the public branch).
            foreach (['INSERT' => 'WITH CHECK', 'UPDATE' => 'USING', 'DELETE' => 'USING'] as $op => $clause) {
                $policy = $table.'_'.strtolower($op).'_policy';
                DB::connection('pgsql_admin')->statement("
                    CREATE POLICY {$policy} ON {$table} FOR {$op}
                    {$clause} (EXISTS (
                        SELECT 1 FROM library
                        WHERE library.book = {$table}.book
                        AND (
                            EXISTS (SELECT 1 FROM users WHERE users.name = library.creator
                                    AND users.user_token::text = current_setting('app.current_token', true))
                            OR (library.creator IS NULL AND library.creator_token IS NOT NULL
                                AND library.creator_token::text = current_setting('app.current_token', true))
                        )
                    ))
                ");
            }
        }
    }

    public function down(): void
    {
        foreach (['book_audio', 'book_audio_meta'] as $table) {
            foreach (['select', 'insert', 'update', 'delete'] as $op) {
                DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS {$table}_{$op}_policy ON {$table}");
            }
            DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS {$table}");
        }
    }
};
