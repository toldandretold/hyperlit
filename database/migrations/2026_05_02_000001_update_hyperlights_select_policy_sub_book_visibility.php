<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->unprepared("
            DROP POLICY IF EXISTS hyperlights_select_policy ON public.hyperlights;

            CREATE POLICY hyperlights_select_policy ON public.hyperlights FOR SELECT USING (
                -- 1. Parent book is public (anyone can see)
                (EXISTS (
                    SELECT 1 FROM public.library
                    WHERE (library.book)::text = (hyperlights.book)::text
                    AND (library.visibility)::text = 'public'
                ))
                OR
                -- 2. Highlight's own sub-book is public
                (hyperlights.sub_book_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.library
                    WHERE (library.book)::text = (hyperlights.sub_book_id)::text
                    AND (library.visibility)::text = 'public'
                ))
                OR
                -- 3. Current user is the highlight creator
                (EXISTS (
                    SELECT 1 FROM public.users
                    WHERE (users.name)::text = (hyperlights.creator)::text
                    AND (users.user_token)::text = current_setting('app.current_token', true)
                ))
                OR
                -- 4. Anonymous creator with matching token
                (creator IS NULL AND creator_token IS NOT NULL
                 AND (creator_token)::text = current_setting('app.current_token', true))
            );
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->unprepared("
            DROP POLICY IF EXISTS hyperlights_select_policy ON public.hyperlights;

            CREATE POLICY hyperlights_select_policy ON public.hyperlights FOR SELECT USING (
                (EXISTS (
                    SELECT 1 FROM public.library
                    WHERE (library.book)::text = (hyperlights.book)::text
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
    }
};
