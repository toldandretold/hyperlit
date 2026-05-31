-- ============================================================================
-- check_empty_hypercites.sql
--
-- Counts "empty" (zero-width) hypercites & hyperlights in production — the
-- corruption where a node's charStart === charEnd. This is the signature of the
-- enclosing-cite split-residue bug: an empty duplicate <u>/<mark> left behind by
-- range.extractContents() got measured as 0-width and overwrote the real range,
-- so the cite never renders and can't be navigated to.
--
-- Position data lives in the jsonb "charData" column, keyed by node_id:
--     {"<node_id>": {"charStart": N, "charEnd": M}, ...}
-- A cite may span several nodes; ANY node entry with charStart === charEnd (and
-- >= 0, to exclude ghost tombstones which are intentionally -1/-1) is corrupt.
--
-- ⚠️  ROW-LEVEL SECURITY: hypercites & hyperlights have FORCE ROW LEVEL SECURITY,
--     with policies that only expose public books or rows matching the per-request
--     session user/token. So a normal app/owner role will UNDER-count.
--     RUN THIS AS A POSTGRES SUPERUSER (e.g. the `postgres` role), which bypasses
--     RLS entirely — see the run instructions at the bottom of this file.
-- ============================================================================

\echo ''
\echo '======================================================================'
\echo ' EMPTY (zero-width) HYPERCITES'
\echo '======================================================================'

-- Distinct cites that have at least one zero-width node entry (the headline number)
\echo '-- distinct corrupt hypercites:'
SELECT count(DISTINCT h.id) AS corrupt_hypercites
FROM hypercites h,
     LATERAL jsonb_each(CASE WHEN jsonb_typeof(h."charData") = 'object' THEN h."charData" ELSE '{}'::jsonb END) AS e(node_id, pos)
WHERE jsonb_typeof(e.pos) = 'object'
  AND (e.pos->>'charStart') ~ '^-?\d+$'
  AND (e.pos->>'charEnd')   ~ '^-?\d+$'
  AND (e.pos->>'charStart')::int = (e.pos->>'charEnd')::int
  AND (e.pos->>'charStart')::int >= 0;

-- Total zero-width (cite, node) pairs (a multi-node cite can contribute several)
\echo '-- total corrupt (cite,node) entries:'
SELECT count(*) AS corrupt_entries
FROM hypercites h,
     LATERAL jsonb_each(CASE WHEN jsonb_typeof(h."charData") = 'object' THEN h."charData" ELSE '{}'::jsonb END) AS e(node_id, pos)
WHERE jsonb_typeof(e.pos) = 'object'
  AND (e.pos->>'charStart') ~ '^-?\d+$'
  AND (e.pos->>'charEnd')   ~ '^-?\d+$'
  AND (e.pos->>'charStart')::int = (e.pos->>'charEnd')::int
  AND (e.pos->>'charStart')::int >= 0;

-- A sample so you can eyeball them
\echo '-- sample (up to 30):'
SELECT h.id,
       h.book,
       h."hyperciteId",
       e.node_id,
       (e.pos->>'charStart')::int AS char_start,
       (e.pos->>'charEnd')::int   AS char_end,
       left(h."hypercitedText", 60) AS text_preview
FROM hypercites h,
     LATERAL jsonb_each(CASE WHEN jsonb_typeof(h."charData") = 'object' THEN h."charData" ELSE '{}'::jsonb END) AS e(node_id, pos)
WHERE jsonb_typeof(e.pos) = 'object'
  AND (e.pos->>'charStart') ~ '^-?\d+$'
  AND (e.pos->>'charEnd')   ~ '^-?\d+$'
  AND (e.pos->>'charStart')::int = (e.pos->>'charEnd')::int
  AND (e.pos->>'charStart')::int >= 0
ORDER BY h.id
LIMIT 30;

-- Bonus: malformed charData that isn't even a JSON object (array/string/null/scalar).
-- These are a SEPARATE corruption — the cite has no usable per-node positions at all.
\echo '-- hypercites with malformed (non-object) charData, by type:'
SELECT COALESCE(jsonb_typeof("charData"), 'sql_null') AS chardata_type,
       count(*) AS n
FROM hypercites
WHERE "charData" IS NULL OR jsonb_typeof("charData") <> 'object'
GROUP BY 1
ORDER BY n DESC;

\echo ''
\echo '======================================================================'
\echo ' EMPTY (zero-width) HYPERLIGHTS  (the same guard covers <mark> too)'
\echo '======================================================================'

\echo '-- distinct corrupt hyperlights:'
SELECT count(DISTINCT hl.id) AS corrupt_hyperlights
FROM hyperlights hl,
     LATERAL jsonb_each(CASE WHEN jsonb_typeof(hl."charData") = 'object' THEN hl."charData" ELSE '{}'::jsonb END) AS e(node_id, pos)
WHERE jsonb_typeof(e.pos) = 'object'
  AND (e.pos->>'charStart') ~ '^-?\d+$'
  AND (e.pos->>'charEnd')   ~ '^-?\d+$'
  AND (e.pos->>'charStart')::int = (e.pos->>'charEnd')::int
  AND (e.pos->>'charStart')::int >= 0;

-- ============================================================================
-- HOW TO RUN (from the Laravel app root on the prod box, where .env lives):
--
--   # Pull the DB name out of .env, then run as the postgres superuser
--   # (superuser bypasses FORCE row-level security):
--   DB=$(grep -E '^DB_DATABASE=' .env | cut -d= -f2- | tr -d '"'"'"' \r")
--   sudo -u postgres psql -d "$DB" -f scripts/check_empty_hypercites.sql
--
-- If Postgres is remote/managed (no local `postgres` user), connect with a
-- superuser (or a role that has BYPASSRLS) instead:
--
--   psql "postgresql://SUPERUSER:PASSWORD@DB_HOST:5432/DB_NAME" \
--        -f scripts/check_empty_hypercites.sql
--
-- Last resort if you only have the app role: temporarily let it bypass RLS
-- (must be run by a superuser), get the count, then revoke:
--
--   ALTER ROLE forge BYPASSRLS;     -- replace `forge` with your DB_USERNAME
--   \i scripts/check_empty_hypercites.sql
--   ALTER ROLE forge NOBYPASSRLS;
-- ============================================================================
