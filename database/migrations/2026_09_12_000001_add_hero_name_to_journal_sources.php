<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * A hand-set SHORT name for the /j/{slug} hero lockup.
 *
 * `display_name` is OpenAlex's — it is the journal's citation identity (it goes in the
 * <title>, the meta description and the Periodical JSON-LD) and must not be shortened,
 * but it is also whatever the venue registered: "tripleC Communication Capitalism &
 * Critique Open Access Journal for a Global Sustainable Information Society" is NINE
 * lines in the hero, and the colon squares track the title block's height, so the mark
 * stretches to 342px with the two squares floating a screen apart.
 *
 * Hence a separate column rather than editing display_name in place: `journal:sync-registry`
 * overwrites display_name from OpenAlex on every run, so an edit there would silently
 * revert, and the full name is still the right thing for SEO and citation.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE journal_sources
                ADD COLUMN hero_name varchar(120) NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE journal_sources
                DROP COLUMN IF EXISTS hero_name
        ");
    }
};
