<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Per-host answer to "can we read this publisher at all, and what have we already tried?"
 *
 * Separate from `fetch_host_policy`, which answers a different question — HOW to route a fetch
 * (direct or through the residential proxy). This one answers WHETHER the attempt is worth making,
 * and records the ladder that was spent finding out.
 *
 * The cost it exists to stop: citation resolution now walks plain GET → headless browser →
 * managed unblocker → unblocker with JS rendering → landing-page PDF hunt. On a host that refuses
 * all of it that is **201 seconds of wall clock per URL**, measured across chacko's corpus — where
 * five hosts (economist.com, indiankanoon.org, fbi.gov, digitallibrary.un.org) accounted for a
 * large share of a 39-minute run and produced nothing. A heavily-cited article would add half an
 * hour to a review to re-learn what the previous review already knew.
 *
 * But a skip-list alone would be the wrong shape. The second reason this table exists is to be a
 * RECORD: which hosts cost us citations, what they answered, and which channels have been tried.
 * That is the input to ever improving the methods — without it, "we can't read the Economist" is
 * folklore rather than a number, and there is no way to tell a host that needs a new technique
 * from one that is simply gone.
 *
 * Only genuinely host-level outcomes are recorded (`blocked`, `unreachable`). A 404 is about the
 * URL, not the publisher, and recording it here would condemn a whole domain for one rotted link.
 *
 * Cooldown is a BACKOFF LADDER, not a permanent verdict, for the same reason
 * HarvestAttemptRecorder's is: bot walls are often rate-based and a host that refuses today may
 * serve next month. Nothing is ever retired forever.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE fetch_host_reachability (
                host varchar(255) PRIMARY KEY,

                -- The last host-level outcome: 'blocked' (refused — a live source we cannot see)
                -- or 'unreachable' (no response at all). Deliberately not 'dead': that is a
                -- property of a URL.
                outcome varchar(20) NOT NULL,

                -- What the host actually said, kept verbatim for the operator. 'blocked' with no
                -- evidence is indistinguishable from a bug, and this is the only record of it.
                reason text NULL,
                http_status integer NULL,

                -- Which rungs were spent before giving up, e.g. ['plain','browser','unblocker',
                -- 'unblocker_render']. This is what tells you whether a NEW technique is worth
                -- trying on a host or whether everything already has been.
                channels_tried jsonb NOT NULL DEFAULT '[]'::jsonb,

                consecutive_failures integer NOT NULL DEFAULT 0,
                successes integer NOT NULL DEFAULT 0,

                -- How many distinct citations this host has cost us. The ranking column for
                -- 'where would effort pay most'.
                citations_blocked integer NOT NULL DEFAULT 0,

                -- Cooling off until this moment; a fetch inside the window is skipped.
                retry_after timestamptz NULL,

                first_failed_at timestamptz NOT NULL DEFAULT NOW(),
                last_attempt_at timestamptz NOT NULL DEFAULT NOW(),
                created_at timestamptz NOT NULL DEFAULT NOW(),
                updated_at timestamptz NOT NULL DEFAULT NOW()
            )
        ");

        // The two read patterns: 'is this host cooling off' and 'rank hosts by what they cost us'.
        DB::connection('pgsql_admin')->statement(
            'CREATE INDEX fetch_host_reachability_retry_idx ON fetch_host_reachability (retry_after)'
        );
        DB::connection('pgsql_admin')->statement(
            'CREATE INDEX fetch_host_reachability_cost_idx ON fetch_host_reachability (citations_blocked DESC)'
        );

        DB::connection('pgsql_admin')->statement(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON fetch_host_reachability TO {$appUser}"
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS fetch_host_reachability');
    }
};
