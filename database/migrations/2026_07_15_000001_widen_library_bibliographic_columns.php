<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Bibliographic metadata arrives from the wild (OpenAlex, Open Library,
     * LLM extraction) and does not fit in varchar(255): a dual-language title
     * ("Naskol'ko differentsirovano … [How Different are the Models …]",
     * ~290 chars) crashed a production harvest with SQLSTATE 22001, and a
     * many-author paper will do the same to `author` eventually. Truncating
     * would corrupt citations, so widen to text — the convention
     * `canonical_source` already uses for exactly these fields.
     *
     * `search_vector` is a GENERATED column over several of these fields, and
     * Postgres refuses ALTER TYPE on a generated column's sources — so it is
     * dropped and rebuilt (same weights, same GIN index name). ADD ... STORED
     * rewrites the table, which is fine: library is one row per book.
     *
     * Deliberately untouched: identifier/system columns (book, creator, slug,
     * type, doi, fileName, …) — those are OUR formats, 255 is a real bound.
     */
    private const COLUMNS = [
        'title', 'author', 'journal', 'publisher', 'booktitle',
        'editor', 'school', 'chapter', 'volume', 'issue', 'pages', 'year',
    ];

    public function up(): void
    {
        DB::statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');

        foreach (self::COLUMNS as $col) {
            DB::statement("ALTER TABLE library ALTER COLUMN \"{$col}\" TYPE text");
        }

        // Same expression + weights as the original (2026-07 search overhaul),
        // minus the varchar casts the old column needed.
        DB::statement(<<<'SQL'
            ALTER TABLE library ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', COALESCE(author, '')), 'A')
                || setweight(to_tsvector('simple', COALESCE(title, '')), 'B')
                || setweight(to_tsvector('simple', COALESCE(booktitle, '')), 'C')
                || setweight(to_tsvector('simple', COALESCE(chapter, '')), 'C')
                || setweight(to_tsvector('simple', COALESCE(editor, '')), 'D')
                || setweight(to_tsvector('simple', COALESCE(year, '')), 'D')
            ) STORED
            SQL);
        DB::statement('CREATE INDEX library_search_vector_idx ON library USING gin (search_vector)');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE library DROP COLUMN IF EXISTS search_vector');

        // Best-effort reverse: truncates any value that outgrew the old cap.
        foreach (self::COLUMNS as $col) {
            DB::statement("ALTER TABLE library ALTER COLUMN \"{$col}\" TYPE varchar(255) USING left(\"{$col}\", 255)");
        }

        DB::statement(<<<'SQL'
            ALTER TABLE library ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', COALESCE(author, '')::text), 'A')
                || setweight(to_tsvector('simple', COALESCE(title, '')::text), 'B')
                || setweight(to_tsvector('simple', COALESCE(booktitle, '')::text), 'C')
                || setweight(to_tsvector('simple', COALESCE(chapter, '')::text), 'C')
                || setweight(to_tsvector('simple', COALESCE(editor, '')::text), 'D')
                || setweight(to_tsvector('simple', COALESCE(year, '')::text), 'D')
            ) STORED
            SQL);
        DB::statement('CREATE INDEX library_search_vector_idx ON library USING gin (search_vector)');
    }
};
