<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Authors as identities (docs/authors.md). `authors` is one row per PERSON,
 * filled from Wikidata; `book_authors` links a library row to a person with a
 * role; `archive_sources` learns that an /a/{slug} page can be an AUTHOR page
 * (a system-maintained shelf of that person's public books).
 *
 * No RLS, and the app role only gets SELECT: both tables are shared reference
 * data with ONE writer each (App\Services\Authors\AuthorRegistry and
 * AuthorLinker, both on pgsql_admin). `library.author` — the credit as printed
 * — is untouched by any of this.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');
        $db = DB::connection('pgsql_admin');

        $db->statement("
            CREATE TABLE authors (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

                slug varchar(100) NOT NULL UNIQUE,
                display_name varchar(255) NOT NULL,
                sort_name varchar(255) NULL,
                description text NULL,

                aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
                alias_keys text[] NOT NULL DEFAULT '{}',

                wikidata_qid varchar(20) NULL UNIQUE,
                open_library_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
                openalex_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
                orcid varchar(32) NULL,
                viaf varchar(32) NULL,

                born integer NULL,
                died integer NULL,

                created_at timestamp DEFAULT NOW(),
                updated_at timestamp DEFAULT NOW()
            )
        ");
        $db->statement('CREATE INDEX authors_alias_keys_idx ON authors USING GIN (alias_keys)');
        $db->statement('CREATE INDEX authors_open_library_ids_idx ON authors USING GIN (open_library_ids)');
        $db->statement('CREATE INDEX authors_openalex_ids_idx ON authors USING GIN (openalex_ids)');
        $db->statement('CREATE INDEX authors_orcid_idx ON authors (orcid) WHERE orcid IS NOT NULL');
        // SELECT only — and REVOKE first: this database's default privileges hand the app role
        // full DML on every new table, which would make "one writer" a comment, not a fact.
        $db->statement("REVOKE ALL ON authors FROM {$appUser}");
        $db->statement("GRANT SELECT ON authors TO {$appUser}");

        $db->statement("
            CREATE TABLE book_authors (
                book varchar NOT NULL,
                author_id uuid NOT NULL REFERENCES authors (id) ON DELETE CASCADE,
                role varchar(20) NOT NULL DEFAULT 'author',
                position integer NULL,
                source varchar(20) NOT NULL,
                created_at timestamp DEFAULT NOW(),
                PRIMARY KEY (book, author_id, role)
            )
        ");
        $db->statement('CREATE INDEX book_authors_author_idx ON book_authors (author_id, role)');
        $db->statement("REVOKE ALL ON book_authors FROM {$appUser}");
        $db->statement("GRANT SELECT ON book_authors TO {$appUser}");

        $db->statement("ALTER TABLE archive_sources ADD COLUMN kind varchar(20) NOT NULL DEFAULT 'collection'");
        $db->statement('ALTER TABLE archive_sources ADD COLUMN author_id uuid NULL UNIQUE');
    }

    public function down(): void
    {
        $db = DB::connection('pgsql_admin');
        $db->statement('ALTER TABLE archive_sources DROP COLUMN IF EXISTS author_id');
        $db->statement('ALTER TABLE archive_sources DROP COLUMN IF EXISTS kind');
        $db->statement('DROP TABLE IF EXISTS book_authors');
        $db->statement('DROP TABLE IF EXISTS authors');
    }
};
