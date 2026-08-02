# Deploy: nodes storage shrink (halfvec + expression FTS indexes)

One deploy, three migrations plus matching query changes. It takes the `nodes` table from **2.8 GB to roughly 1.8–1.9 GB** with zero search-behaviour change, and cuts the per-node storage cost of future mass imports roughly in half. Background: the 2026-08 storage audit (this doc is the operational half; the reasoning lives in the conversation that produced it and in the migration file comments).

## What ships

- **`2026_08_01_000004_replace_stored_tsvectors_with_expression_indexes`** — drops the two STORED tsvector columns (`search_vector`, `search_vector_simple`, ~420 MB of redundant per-row data) and replaces them with expression GIN indexes (`nodes_fts_english_idx`, `nodes_fts_simple_idx`). Matching and ranking are identical; the tsvector is simply recomputed for the handful of rows being ranked instead of read off the row. Also fixes the E2EE wart: the new expression is `COALESCE("plainText", '')` — no more falling through to `content`, which for encrypted books meant GIN-indexing their own ciphertext. Legacy non-encrypted rows that had only HTML content get `plainText` backfilled first, so they keep matching.
- **`2026_08_01_000005_drop_unused_nodes_sys_period_index`** — drops the 65 MB GIST index on live `nodes.sys_period` (0 lifetime scans; point-in-time queries use `nodes_history`, which keeps its own index).
- **`2026_08_02_000001_convert_nodes_embedding_to_halfvec`** — `vector(768)` fp32 → `halfvec(768)` fp16: embedding data 424 → ~212 MB, HNSW index 547 → ~280 MB, negligible recall loss. Prod pgvector is 0.8.1, comfortably ≥ the 0.7 requirement.
- **Query/code changes riding along** — `SearchService` (new `nodeTsExpression()` helper is now the single config whitelist), `SearchController`, `ShelfController`, `PassageSearcher`, `SearchProfileCommand`, `EmbeddingService` (also switched to `search_read_connection` — under RLS the planner refused the HNSW scan because pgvector's operators aren't LEAKPROOF, which is why `idx_nodes_embedding` had **zero** lifetime scans), `GenerateNodeEmbedding` / `BackfillEmbeddings` (`::halfvec` casts), `StorageController` (composition sampler no longer reads the dropped columns).

**Migration order is deliberate:** the two `08_01` files are dated before the `08_02` halfvec one so the columns are dropped BEFORE the halfvec `ALTER TYPE` rewrites the table — the rewrite then reclaims the dropped columns' space for free. **No `VACUUM FULL` needed.** Don't rename the files.

## The deploy command

```bash
ssh marx@170.64.145.89
cd /var/www/hyperlit && ./deploy/deploy.sh --maintenance
```

## Do we need maintenance mode? (yes, this once)

Use `--maintenance`. The halfvec migration's `ALTER TABLE ... ALTER COLUMN TYPE` rewrites the entire nodes table (~1.8 GB) under an ACCESS EXCLUSIVE lock, and the GIN index builds block writes — during that window every request touching `nodes` piles up on php-fpm workers until it times out. Readers mostly survive (book content is served from cached `nodes.json`, in-book search is client-side) and editors' saves would queue and retry in the sync queue, but a pile-up of stuck requests is a worse experience than a clean maintenance page. Pick a quiet hour.

Expected duration: dev (11.5k nodes / 5.2k vectors) took ~65s for all three; prod is ~40× the rows and ~26× the vectors on managed-DB hardware, so budget **10–30 minutes** in maintenance. The breakdown: backfill (fast) → two GIN builds (~1–3 min each) → column drops (instant) → table rewrite + HNSW rebuild (the bulk).

## After the deploy

`deploy.sh` restarts the queue workers itself — that step matters more than usual here, because a stale worker would write `::vector` casts against the halfvec column. If you deploy any other way, `php artisan queue:restart` is mandatory.

Verify from `php artisan db pgsql_admin`:

```sql
-- table shape: expect total ≈ 1.8–1.9 GB (was 2.8 GB)
SELECT pg_size_pretty(pg_total_relation_size('nodes')) AS total,
       pg_size_pretty(pg_relation_size('nodes')) AS heap,
       pg_size_pretty(pg_indexes_size('nodes')) AS indexes;

-- index roster: idx_nodes_embedding ≈ 280 MB (was 547), nodes_fts_* present,
-- nodes_search_vector_* and nodes_sys_period_idx gone
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes WHERE relname = 'nodes'
ORDER BY pg_relation_size(indexrelid) DESC;

-- embeddings halved: expect avg ≈ 1541 bytes (was 3080)
SELECT round(avg(pg_column_size(embedding))) FROM nodes WHERE embedding IS NOT NULL;

-- the FTS expression index is actually planner-matched (expect Bitmap Index Scan)
EXPLAIN (COSTS OFF) SELECT 1 FROM nodes
WHERE to_tsvector('simple', COALESCE("plainText", '')) @@ to_tsquery('simple', 'economy') LIMIT 5;
```

Then smoke the product surfaces: homepage search (exact + a stemmed-only word), a shelf search, and an AI brain question. A few days later, re-check `idx_scan` on `idx_nodes_embedding` after using AI brain — it should finally be non-zero.

## Rollback

`php artisan migrate:rollback --step=3` restores everything (stored generated columns regenerate themselves — that's another full-table rewrite, so it's slow, and the fp32 vectors are re-expanded from fp16, which is fine). The code must be reverted in the same breath (`git revert` the deploy commit) — the new queries reference expressions, the old ones reference columns, and each only works against its own schema.

## Test coverage at ship time

- PHP (all green locally): `tests/Feature/AiBrain` (retrieval privacy contracts + keyword scopes), `tests/Feature/Citations`, `tests/Feature/CitationPipeline/PassageSearcherTest`, `tests/Feature/EmbeddingWorkerRlsTest`, `tests/Feature/Security/SqlInjectionTest` (search endpoints), `tests/Feature/Storage`.
- Exercised by hand: `search:profile` all four query shapes, OR-ranked and AND/phrase node search, EXPLAIN plans for both FTS indexes and HNSW.
- Nothing in `resources/js` changed; the e2e suite (`npm run test:e2e`) is still the right pre-push ritual, with search + AI brain the areas worth eyeballing.
