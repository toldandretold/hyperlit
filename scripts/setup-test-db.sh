#!/usr/bin/env bash
#
# Provision the dedicated test database (my_laravel_db_test) so `php artisan test`
# never wipes the dev DB that Herd serves. Idempotent — safe to re-run.
#
# Why this is needed: the suite uses RefreshDatabase (migrate:fresh). Without a
# separate DB it migrate:fresh'es .env's DB_DATABASE = the dev DB. We point tests
# at my_laravel_db_test via phpunit.xml + .env.testing; this script builds it.
#
# Replicating the dev DB's RLS setup needs three things migrations DON'T do on a
# fresh DB: the DB itself, the required extensions (superuser), and the GRANTs to
# the non-owner app role (so RLS — which is FORCE'd — actually applies to it).
#
# Run from the project root:  bash scripts/setup-test-db.sh

set -euo pipefail
cd "$(dirname "$0")/.."

DB=my_laravel_db_test
echo "→ Provisioning ${DB}"

# 1) Create the database (via the admin/superuser connection in .env).
php artisan tinker --execute="
try { DB::connection('pgsql_admin')->statement('CREATE DATABASE ${DB} OWNER hyperlit_app'); echo 'created\n'; }
catch (\Throwable \$e) { echo (str_contains(\$e->getMessage(),'already exists') ? 'exists\n' : 'ERR: '.\$e->getMessage().\"\n\"); }
"

# 2) Extensions (need superuser; the app role can't CREATE EXTENSION).
php artisan --env=testing tinker --execute="
foreach (['vector','pg_trgm','pgcrypto'] as \$x) {
  DB::connection('pgsql_admin')->statement(\"CREATE EXTENSION IF NOT EXISTS \\\"\$x\\\"\");
}
echo \"extensions ok\n\";
"

# 3) Schema + RLS policies (plain migrate — migrate:fresh is prohibited project-wide;
#    the DB is empty so migrate builds everything).
php artisan migrate --env=testing --force

# 4) GRANTs to the app role. Migrations create the tables (owned by the admin role)
#    and the FORCE'd RLS policies, but NOT the app-role grants the dev DB was
#    provisioned with — without these the app role gets "permission denied".
php artisan --env=testing tinker --execute="
\$a = DB::connection('pgsql_admin');
foreach ([
  'GRANT USAGE ON SCHEMA public TO hyperlit_app',
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hyperlit_app',
  'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hyperlit_app',
  'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hyperlit_app',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hyperlit_app',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hyperlit_app',
] as \$s) { \$a->statement(\$s); }
echo \"grants ok\n\";
"

echo "✓ ${DB} ready.  Verify:  php artisan test tests/Feature/Security/UserTokenRlsTest.php"
