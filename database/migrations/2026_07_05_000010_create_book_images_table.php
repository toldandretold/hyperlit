<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Unified book-image store — metadata + lifecycle source of truth (docs/e2ee.md).
 *
 * One row per image belonging to a book. The image BYTES live on a private
 * Flysystem disk (storage/app/books/{book}/images/), never public-served; this
 * table governs existence, ownership and the encrypted flag. RLS mirrors the
 * `nodes` policies (join `library` on book) so an image is visible/writable to
 * exactly whoever may see/edit the owning book — which finally puts image
 * access under the same security model as node content (the old EPUB
 * public-symlink path bypassed RLS entirely).
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE book_images (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                book varchar(255) NOT NULL,          -- ROOT book id; all <img src> use the root id
                filename varchar(255) NOT NULL,
                mime varchar(100) NOT NULL,          -- plaintext mime, even when the bytes are encrypted
                bytes bigint NOT NULL DEFAULT 0,     -- size on disk (ciphertext size when encrypted)
                width integer NULL,                  -- plaintext pixel dims (layout; only dims leak when encrypted)
                height integer NULL,
                encrypted boolean NOT NULL DEFAULT false,
                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW(),
                CONSTRAINT book_images_book_filename_unique UNIQUE (book, filename)
            )
        ");

        DB::connection('pgsql_admin')->statement("CREATE INDEX book_images_book_idx ON book_images (book)");

        DB::connection('pgsql_admin')->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON book_images TO {$appUser}");

        DB::connection('pgsql_admin')->statement("ALTER TABLE book_images ENABLE ROW LEVEL SECURITY");
        DB::connection('pgsql_admin')->statement("ALTER TABLE book_images FORCE ROW LEVEL SECURITY");

        // SELECT: visible if the owning book is public, or owned by the caller
        // (logged-in owner by user_token, or anonymous creator by anon token).
        // Mirrors nodes_select_policy minus the user_home branch (home pages
        // never carry imported images).
        DB::connection('pgsql_admin')->statement("
            CREATE POLICY book_images_select_policy ON book_images FOR SELECT
            USING (EXISTS (
                SELECT 1 FROM library
                WHERE library.book = book_images.book
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
            $policy = 'book_images_'.strtolower($op).'_policy';
            DB::connection('pgsql_admin')->statement("
                CREATE POLICY {$policy} ON book_images FOR {$op}
                {$clause} (EXISTS (
                    SELECT 1 FROM library
                    WHERE library.book = book_images.book
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

    public function down(): void
    {
        foreach (['select', 'insert', 'update', 'delete'] as $op) {
            DB::connection('pgsql_admin')->statement("DROP POLICY IF EXISTS book_images_{$op}_policy ON book_images");
        }
        DB::connection('pgsql_admin')->statement("DROP TABLE IF EXISTS book_images");
    }
};
