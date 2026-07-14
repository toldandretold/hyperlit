<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // Durable cache of a work's OA download candidates (OaLocationResolver's
        // work-level gather), so re-harvests / retries never re-call the slow free
        // APIs — OpenAlex, Unpaywall, Semantic Scholar, Crossref — for data we
        // already pulled. Keyed on canonical IDENTITY, so every version and every
        // citing book shares the one pull.
        //
        // Semantics: oa_locations IS NULL = never resolved (cache MISS → gather).
        // oa_locations = '[]' = resolved, no extra work-level copies found — a
        // cache HIT, do NOT re-call. Refresh is force-only by design: OA locations
        // change additively and slowly (open->closed is "exceedingly rare"), and a
        // fetch FAILURE is almost always ours (Cloudflare wall / infra), not a
        // stale URL — so failures must never trigger a re-pull.
        // See app/Services/SourceImport/Content/OaLocationResolver.php.
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
                ADD COLUMN oa_locations jsonb NULL,
                ADD COLUMN oa_locations_fetched_at timestamptz NULL
        ");
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement("
            ALTER TABLE canonical_source
                DROP COLUMN IF EXISTS oa_locations,
                DROP COLUMN IF EXISTS oa_locations_fetched_at
        ");
    }
};
