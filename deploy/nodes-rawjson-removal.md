# Deploying the `nodes.raw_json` removal to prod

This ships the removal of the `raw_json` column from the `nodes` and `nodes_history` tables. `raw_json` was a denormalized JSONB copy of each node that the read API rebuilds on the fly from the canonical columns (`content` / `plainText` / `type` / `footnotes`), so nothing needs it — it was pure dead weight (~1.5 GB on prod-shaped data, the single biggest slice of the `nodes` table). This doc is the exact terminal sequence to ship it safely.

## What actually ships vs. what was local-only

Only two things go to prod: the **code changes** (the backend write/read paths and the frontend `e2ee/transform.ts` FIELD_SPECS stop touching `raw_json`) and the **migration** `database/migrations/2026_07_13_000001_drop_raw_json_from_nodes.php`. The local dev-DB shrink (deleting all but a few test books) and the `resources/markdown` clear-out were one-off local operations — they are NOT in the code and will NOT touch prod content. Your prod books are untouched.

## The one hazard: this is a breaking, non-rolling migration

`nodes.raw_json` is `NOT NULL` with no default, so neither half of a rolling deploy is safe: old code still writing `raw_json` against the new (dropped) schema errors with *"column does not exist"*, and new code writing without `raw_json` against the old schema errors with *"null value violates not-null"*. So we deploy code and run the migration together inside a short **maintenance window**. Do not do a rolling deploy.

## The migration itself is instant; reclaiming disk is separate

`ALTER TABLE ... DROP COLUMN` is a metadata-only operation — it finishes in milliseconds even on millions of rows, and the column's data is gone (and unrecoverable) immediately. But it does NOT shrink the database on disk: the bytes sit as dead space until the table is physically rewritten by `VACUUM FULL` or `pg_repack`. So there are two phases — drop (instant, in the window) and reclaim (optional, separate).

## Prerequisites / assumptions

Prod is a DigitalOcean Managed Postgres cluster; the admin role is `doadmin`; the app lives at `/var/www/hyperlit`; the migration runs its `ALTER TABLE` on the `pgsql_admin` connection (make sure that connection is configured with `doadmin` credentials in prod `.env`, or `migrate` won't have DDL rights). Fill in `HOST`, `DBNAME`, `PASSWORD`, and the Postgres major version from the DO control panel (Databases → your cluster → Connection Details) or from `/var/www/hyperlit/.env`.

## Step 0 — Back up first (do not skip)

`DROP COLUMN` is irreversible. Take an explicit dump right before, so you have a precise restore point you control (DO's automatic daily backup + PITR only restore to a *new* forked cluster, which is slower to fall back to). A dump of just the two affected tables is enough and fast:

```bash
pg_dump "postgresql://doadmin:PASSWORD@HOST:25060/DBNAME?sslmode=require" \
  -Fc -t nodes -t nodes_history -f ~/prod_rawjson_tables_$(date +%F).dump
```

For belt-and-braces, dump the whole DB instead (`-Fc` custom format, restorable with `pg_restore`):

```bash
pg_dump "postgresql://doadmin:PASSWORD@HOST:25060/DBNAME?sslmode=require" \
  -Fc -f ~/prod_full_$(date +%F).dump
```

## Step 1 — Deploy in a maintenance window

```bash
cd /var/www/hyperlit

# 1. Confirm ONLY the raw_json migration is pending (nothing unexpected rides along)
php artisan migrate:status | tail -20

# 2. Enter maintenance mode (brief downtime starts here)
php artisan down

# 3. Pull the code
git pull

# 4. PHP deps + autoloader (no new packages, but keep the deploy standard)
composer install --no-dev --optimize-autoloader

# 5. Rebuild front-end assets — e2ee/transform.ts changed (raw_json dropped from FIELD_SPECS)
npm ci
npm run build

# 6. Run the migration — drops raw_json from nodes AND nodes_history (must go together;
#    the temporal versioning() trigger column-matches by name)
php artisan migrate --force

# 7. Refresh framework caches
php artisan config:cache && php artisan route:cache && php artisan view:cache
```

## Step 2 — Reclaim the ~1.5 GB (simple path: in-window VACUUM FULL)

You are already in `php artisan down`, so the simplest reliable reclaim is a `VACUUM FULL` on the two tables. It takes an exclusive lock and rewrites the table (a minute or few at this size) — fine because the site is down anyway. `doadmin` can run it; no extension needed.

```bash
php artisan db --database=pgsql_admin
```
```sql
\timing on
VACUUM FULL nodes;
VACUUM FULL nodes_history;
\q
```

If you would rather not spend the extra downtime, skip this now and use the zero-downtime pg_repack path below AFTER the site is back up.

## Step 3 — Restart workers, then come back up

The import/embedding jobs run in `queue:work` workers that hold the OLD code in memory — a stale worker will keep trying to write `raw_json` and fail. Restart them, THEN lift maintenance.

```bash
php artisan queue:restart      # signals workers to reload the new code
php artisan up                 # site back online
```

If workers run under Supervisor and don't pick up quickly:

```bash
sudo supervisorctl restart all
```

## Step 4 — Verify

```bash
# column is gone from both tables
php artisan db --database=pgsql_admin
```
```sql
SELECT table_name, column_name FROM information_schema.columns
WHERE column_name = 'raw_json' AND table_name IN ('nodes','nodes_history');
-- expect: (0 rows)
\q
```

Then load a book in the reader and confirm nodes render, and create/sync an edit to confirm the write path is healthy. Tail `storage/logs/laravel.log` for any `raw_json`-related errors.

## Zero-downtime reclaim alternative — pg_repack (instead of Step 2)

pg_repack rewrites the table ONLINE (brief locks only at start/end), so you can reclaim the space after the site is already back up. It's confirmed available on this cluster (extension v1.5.0). Two cautions: it builds a full copy of the table first, so you need free disk ≈ the size of `nodes` (check the cluster isn't near full, or it fails mid-run), and the CLI version must line up with the extension.

```bash
# one-time: enable the extension (as doadmin) — via the pgsql_admin connection
php artisan tinker --execute="DB::connection('pgsql_admin')->statement('CREATE EXTENSION IF NOT EXISTS pg_repack');"

# one-time: install the pg_repack CLI on this server, matching the cluster's PG major version
sudo apt-get update
sudo apt-get install -y postgresql-16-repack     # swap 16 for your cluster's major version

# run it (AFTER the migration). -k skips the superuser check — required on managed Postgres
pg_repack -k -h HOST -p 25060 -U doadmin -d DBNAME -t nodes -t nodes_history
```

## Rollback

The migration's `down()` re-adds `raw_json` as a nullable empty column — it does NOT restore the data (that's gone the instant the drop runs). So `php artisan migrate:rollback` only un-breaks old code; it does not bring the values back. If you truly need the old data, restore from the Step 0 dump:

```bash
# restore just the two tables from the targeted dump (into a scratch DB, then copy what you need)
pg_restore -d "postgresql://doadmin:PASSWORD@HOST:25060/DBNAME?sslmode=require" \
  --clean --if-exists -t nodes -t nodes_history ~/prod_rawjson_tables_YYYY-MM-DD.dump
```

In practice you should never need this — `raw_json` was a rebuildable denormalized copy — but the dump is your safety net for the whole deploy, not just the column.
