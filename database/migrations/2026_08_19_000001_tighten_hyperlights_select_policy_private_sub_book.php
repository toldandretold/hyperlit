<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Per-highlight privacy, RLS backstop: a hyperlight whose annotation sub-book's
     * library row is 'private' must be invisible to everyone but its creator — even
     * when the PARENT book is public. The app layer already filters this
     * (DatabaseToIndexedDBController::getHyperlights / DbHyperlightController::find);
     * this tightens the policy so a raw select under the app role can't leak either.
     *
     * The private check MUST be a SECURITY DEFINER function: library has RLS
     * (library_select_policy hides strangers' private rows), so a plain NOT EXISTS
     * subquery inside this policy would never see another creator's private sub-book
     * row and silently pass. DEFINER runs as the admin table owner and bypasses it
     * (precedent: check_book_visibility, hardened in 2026_03_03_000003).
     */
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE OR REPLACE FUNCTION public.annotation_sub_book_is_private(p_sub_book_id text)
            RETURNS boolean
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = public, pg_temp
            AS \$\$
                SELECT EXISTS (
                    SELECT 1 FROM public.library
                    WHERE (library.book)::text = p_sub_book_id
                    AND (library.visibility)::text = 'private'
                );
            \$\$
        ");
        DB::connection('pgsql_admin')->statement('REVOKE EXECUTE ON FUNCTION public.annotation_sub_book_is_private(text) FROM PUBLIC');
        DB::connection('pgsql_admin')->statement("GRANT EXECUTE ON FUNCTION public.annotation_sub_book_is_private(text) TO {$appUser}");

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
                -- 3. Public access — but NEVER when the annotation sub-book is private
                --    (parent-book publicness must not override per-highlight privacy)
                (
                    (hyperlights.sub_book_id IS NULL
                     OR NOT public.annotation_sub_book_is_private((hyperlights.sub_book_id)::text))
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
        // Restore the 2026_05_02_000001 policy body verbatim, then drop the helper.
        DB::connection('pgsql_admin')->unprepared("
            DROP POLICY IF EXISTS hyperlights_select_policy ON public.hyperlights;

            CREATE POLICY hyperlights_select_policy ON public.hyperlights FOR SELECT USING (
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
                OR
                (EXISTS (
                    SELECT 1 FROM public.users
                    WHERE (users.name)::text = (hyperlights.creator)::text
                    AND (users.user_token)::text = current_setting('app.current_token', true)
                ))
                OR
                (creator IS NULL AND creator_token IS NOT NULL
                 AND (creator_token)::text = current_setting('app.current_token', true))
            );
        ");

        DB::connection('pgsql_admin')->statement('DROP FUNCTION IF EXISTS public.annotation_sub_book_is_private(text)');
    }
};
