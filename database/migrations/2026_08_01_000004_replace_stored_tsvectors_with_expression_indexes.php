<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Replace the two STORED generated tsvector columns on nodes with
     * expression GIN indexes over the same to_tsvector() expressions.
     *
     * The stored columns were redundant per-row copies of data the GIN
     * indexes already hold in searchable form (~987 B/row, ~420 MB in prod);
     * matching and ranking are unchanged — ts_rank simply recomputes the
     * tsvector for the handful of candidate rows it scores.
     *
     * Two deliberate changes ride along:
     *
     * 1. The expression is COALESCE("plainText", '') — NOT the old
     *    COALESCE("plainText", content, ''). The content fallback made
     *    E2EE books tsvector-index their own CIPHERTEXT (plainText is
     *    NULLed for them by design, so they fell through to content),
     *    which is pure garbage storage and near-worst-case GIN input.
     *    Legacy non-encrypted rows that relied on the fallback get
     *    plainText backfilled below, so they keep matching.
     *
     * 2. This file is deliberately DATED BEFORE the halfvec migration
     *    (2026_08_02_000001): on prod both are pending, so the columns are
     *    dropped first and the halfvec ALTER TYPE's full-table rewrite then
     *    reclaims their space for free — no VACUUM FULL needed. (Dev/test
     *    already ran halfvec first; there the space returns via normal
     *    churn, or a manual VACUUM FULL, which is irrelevant at dev size.)
     *
     * Queries were updated in the same commit: SearchService, SearchController,
     * ShelfController, CitationReview\Phases\PassageSearcher, SearchProfileCommand.
     * The WHERE/ORDER BY expressions must match the index expressions exactly.
     */
    public function up(): void
    {
        $admin = DB::connection('pgsql_admin');

        // Backfill plainText where the old expression's content-fallback was
        // doing the work: non-encrypted rows with content but no plainText
        // (e.g. auto-version books imported as raw HTML). Tag-strip mirrors
        // PHP strip_tags (entities left as-is, same as PgNode's saving hook).
        $admin->statement(<<<'SQL'
            UPDATE nodes
            SET "plainText" = regexp_replace(content, '<[^>]*>', '', 'g')
            WHERE "plainText" IS NULL
              AND content IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM library l
                  WHERE l.book = nodes.book AND COALESCE(l.encrypted, false)
              )
        SQL);

        // Build the expression indexes while the old columns still serve
        // queries, then swap: drop old indexes + columns.
        $admin->statement(<<<'SQL'
            CREATE INDEX IF NOT EXISTS nodes_fts_english_idx
            ON nodes USING GIN (to_tsvector('english', COALESCE("plainText", '')))
        SQL);
        $admin->statement(<<<'SQL'
            CREATE INDEX IF NOT EXISTS nodes_fts_simple_idx
            ON nodes USING GIN (to_tsvector('simple', COALESCE("plainText", '')))
        SQL);

        $admin->statement('DROP INDEX IF EXISTS nodes_search_vector_idx');
        $admin->statement('DROP INDEX IF EXISTS nodes_search_vector_simple_idx');
        $admin->statement('ALTER TABLE nodes DROP COLUMN IF EXISTS search_vector');
        $admin->statement('ALTER TABLE nodes DROP COLUMN IF EXISTS search_vector_simple');
    }

    public function down(): void
    {
        $admin = DB::connection('pgsql_admin');

        // Faithful restore of the original stored columns (including the
        // content fallback and its E2EE wart) + their GIN indexes.
        $admin->statement(<<<'SQL'
            ALTER TABLE nodes
            ADD COLUMN IF NOT EXISTS search_vector tsvector
            GENERATED ALWAYS AS (to_tsvector('english', COALESCE("plainText", content, ''))) STORED
        SQL);
        $admin->statement(<<<'SQL'
            ALTER TABLE nodes
            ADD COLUMN IF NOT EXISTS search_vector_simple tsvector
            GENERATED ALWAYS AS (to_tsvector('simple', COALESCE("plainText", content, ''))) STORED
        SQL);
        $admin->statement('CREATE INDEX IF NOT EXISTS nodes_search_vector_idx ON nodes USING GIN (search_vector)');
        $admin->statement('CREATE INDEX IF NOT EXISTS nodes_search_vector_simple_idx ON nodes USING GIN (search_vector_simple)');

        $admin->statement('DROP INDEX IF EXISTS nodes_fts_english_idx');
        $admin->statement('DROP INDEX IF EXISTS nodes_fts_simple_idx');
    }
};
