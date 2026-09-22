<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Close the fail-open gap in the 2026_08_19 hyperlights SELECT policy: it
     * only consulted `annotation_sub_book_is_private(sub_book_id)` when the
     * COLUMN was non-NULL, so a highlight whose sub-book library row exists but
     * whose linkage was never stamped (SubBookController::setVisibility's
     * missing-row grace path; legacy rows) sailed through the public branch —
     * the 2026-09-21 private-highlight leak, where the book OWNER could open a
     * reader's private highlight via its deep link.
     *
     * The fix mirrors the app layer (getHyperlights / find now derive the id):
     * when sub_book_id is NULL, check the DERIVED id `{book}/{hyperlight_id}` —
     * the exact id every writer of the annotation library row computes
     * (SubBookIdHelper::build, level 1; deeper levels always have the column
     * stamped by upsert). A missing library row still reads as public, which is
     * correct: no row means no one ever asked for privacy.
     */
    public function up(): void
    {
        DB::connection('pgsql_admin')->unprepared("
            DROP POLICY IF EXISTS hyperlights_select_policy ON public.hyperlights;

            CREATE POLICY hyperlights_select_policy ON public.hyperlights FOR SELECT USING (
                -- 1. Current user is the highlight creator
                (EXISTS (
                    SELECT 1 FROM public.users
                    WHERE (users.name)::text = (hyperlights.creator)::text
                    AND (users.user_token)::text = current_setting('app.current_token', true)
                ))
                OR
                -- 2. Anonymous creator with matching token
                (creator IS NULL AND creator_token IS NOT NULL
                 AND (creator_token)::text = current_setting('app.current_token', true))
                OR
                -- 3. Public access — but NEVER when the annotation sub-book is
                --    private. FAIL-CLOSED: an unstamped sub_book_id column is
                --    checked against the derived {book}/{hyperlight_id} id.
                (
                    NOT public.annotation_sub_book_is_private(
                        COALESCE(
                            (hyperlights.sub_book_id)::text,
                            (hyperlights.book)::text || '/' || (hyperlights.hyperlight_id)::text
                        )
                    )
                    AND (
                        -- 3a. Parent book is public
                        (EXISTS (
                            SELECT 1 FROM public.library
                            WHERE (library.book)::text = (hyperlights.book)::text
                            AND (library.visibility)::text = 'public'
                        ))
                        OR
                        -- 3b. Highlight's own sub-book is public
                        (hyperlights.sub_book_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM public.library
                            WHERE (library.book)::text = (hyperlights.sub_book_id)::text
                            AND (library.visibility)::text = 'public'
                        ))
                    )
                )
            );
        ");
    }

    public function down(): void
    {
        // Restore the 2026_08_19_000001 policy body verbatim.
        DB::connection('pgsql_admin')->unprepared("
            DROP POLICY IF EXISTS hyperlights_select_policy ON public.hyperlights;

            CREATE POLICY hyperlights_select_policy ON public.hyperlights FOR SELECT USING (
                (EXISTS (
                    SELECT 1 FROM public.users
                    WHERE (users.name)::text = (hyperlights.creator)::text
                    AND (users.user_token)::text = current_setting('app.current_token', true)
                ))
                OR
                (creator IS NULL AND creator_token IS NOT NULL
                 AND (creator_token)::text = current_setting('app.current_token', true))
                OR
                (
                    (hyperlights.sub_book_id IS NULL
                     OR NOT public.annotation_sub_book_is_private((hyperlights.sub_book_id)::text))
                    AND (
                        (EXISTS (
                            SELECT 1 FROM public.library
                            WHERE (library.book)::text = (hyperlights.book)::text
                            AND (library.visibility)::text = 'public'
                        ))
                        OR
                        (hyperlights.sub_book_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM public.library
                            WHERE (library.book)::text = (hyperlights.sub_book_id)::text
                            AND (library.visibility)::text = 'public'
                        ))
                    )
                )
            );
        ");
    }
};
