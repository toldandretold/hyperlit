<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Create a SECURITY DEFINER function to update annotations_updated_at.
     *
     * This bypasses RLS to allow anyone to update the annotations timestamp
     * on public books when they add highlights/cites, even though they're
     * not the book owner.
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        // Create function to update annotations_updated_at timestamp
        // Only works on public books (security check built-in)
        DB::statement("
            CREATE OR REPLACE FUNCTION update_annotations_timestamp(p_book text, p_timestamp bigint)
            RETURNS boolean
            SECURITY DEFINER
            SET search_path = public
            AS \$\$
            DECLARE
                book_visibility text;
                updated_count int;
            BEGIN
                -- Check if book exists and is public (or owned by current user)
                SELECT visibility INTO book_visibility
                FROM library
                WHERE book = p_book;

                IF book_visibility IS NULL THEN
                    RETURN false;
                END IF;

                -- Allow update if book is public OR user is the owner
                IF book_visibility = 'public'
                   OR EXISTS (
                       SELECT 1 FROM library
                       WHERE book = p_book
                       AND (
                           (creator IS NOT NULL AND creator = current_setting('app.current_user', true))
                           OR (creator_token IS NOT NULL AND creator_token::text = current_setting('app.current_token', true))
                       )
                   )
                THEN
                    UPDATE library
                    SET annotations_updated_at = p_timestamp
                    WHERE book = p_book;

                    GET DIAGNOSTICS updated_count = ROW_COUNT;
                    RETURN updated_count > 0;
                END IF;

                RETURN false;
            END;
            \$\$ LANGUAGE plpgsql;
        ");

        // Restrict who can call the function
        DB::statement("REVOKE EXECUTE ON FUNCTION update_annotations_timestamp(text, bigint) FROM PUBLIC");
        DB::statement("GRANT EXECUTE ON FUNCTION update_annotations_timestamp(text, bigint) TO {$appUser}");
    }

    public function down(): void
    {
        DB::statement("DROP FUNCTION IF EXISTS update_annotations_timestamp(text, bigint)");
    }
};
