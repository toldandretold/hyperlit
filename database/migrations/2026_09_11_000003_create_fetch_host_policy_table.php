<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Per-host answer to "do we need the residential proxy for this publisher?"
 *
 * `SOURCE_FETCH_PROXY` was all-or-nothing, which is wrong in both directions. What a residential
 * pool sells is IP REPUTATION — Cloudflare scores datacenter ASNs badly, consumer ISPs well — and
 * that is a property of the PUBLISHER, not of us. Most of the diamond corpus is OJS installs and
 * institutional repositories with no bot wall at all, so routing those through a metered
 * residential pool buys nothing and is billed per GB (a headed browser pulls 2–5MB an article, plus
 * the PDF). Meanwhile the setting being global made one vendor a single point of failure: an
 * IPRoyal 402 on 2026-09-11 stopped ALL acquisition dead, on both lanes, mid-journal.
 *
 * The decision is a RATCHET, and that matters more than it looks. A host may move from `direct` to
 * `proxy` on any evidence of a wall, at any time, and never automatically back. The reason is
 * Bristol's AWS WAF, which is RATE-based: it serves cleanly and starts challenging partway through
 * a batch. A policy that could revert on a later clean response would oscillate, and each swing
 * back to `direct` costs another datacenter-IP probe against a host already known to wall us.
 *
 * The seeding path exists so the common case never probes at all: `harvest:seed-proxy-policy`
 * marks the hosts of diamond-journal works `direct` up front, because a probe is not free — a
 * refused request still teaches Cloudflare that this droplet scrapes, and that reputation damage
 * is effectively permanent and shared across the whole datacenter range.
 *
 * `host` is the primary key: policy is about the address we are asking, and one publisher host
 * serves many journals and thousands of works.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE fetch_host_policy (
                host varchar(255) PRIMARY KEY,
                mode varchar(10) NOT NULL DEFAULT 'direct',

                -- Why it was decided, kept for the operator: 'proxy' with no evidence is
                -- indistinguishable from a mistake, and this table is the only record of which
                -- publishers actually wall us.
                evidence text NULL,
                source varchar(30) NOT NULL DEFAULT 'learned',

                direct_successes integer NOT NULL DEFAULT 0,
                wall_hits integer NOT NULL DEFAULT 0,

                decided_at timestamptz NOT NULL DEFAULT NOW(),
                created_at timestamptz NOT NULL DEFAULT NOW(),
                updated_at timestamptz NOT NULL DEFAULT NOW()
            )
        ");

        DB::connection('pgsql_admin')->statement(
            'CREATE INDEX fetch_host_policy_mode_idx ON fetch_host_policy (mode)'
        );

        DB::connection('pgsql_admin')->statement(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON fetch_host_policy TO {$appUser}"
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS fetch_host_policy');
    }
};
