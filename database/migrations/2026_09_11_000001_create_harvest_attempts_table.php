<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Retry backoff for harvest selection — the thing that lets a big journal actually finish.
 *
 * Both harvest queues used to have no memory. "Can this work be fetched?" was a pure statement
 * about the work — no version yet, open access, something fetchable — so a work that FAILED stayed
 * selectable on identical terms forever. And because both queues are ordered `cited_by_count DESC`,
 * a failing work is usually a HIGH-CITATION one, i.e. it sits at the very front. Every subsequent
 * run therefore re-attempted the same corpse first, and the browser rung spends its full 75s
 * process timeout before giving up.
 *
 * Measured on tripleC (2026-09-10): a 50-minute bulk run managed 73 of 960 works and left 7 dead
 * ones pinned at the head of the queue. Twelve more runs would each have paid that toll again, with
 * the dead set growing every round — the tail of the journal was mathematically unreachable.
 *
 * A TABLE keyed by (canonical, lane) rather than columns on `canonical_source`, because the two
 * lanes are selected by two different queries over two different predicates:
 * `HarvestEligibility::eligibleCanonicalsForJournal` (PDF; requires `auto_version_book IS NULL`)
 * and `HtmlLaneCreator::pendingForJournal` (HTML; requires no converted HTML lane — deliberately
 * INCLUDING works the PDF pass already claimed). Shared columns would make an HTML failure
 * suppress the PDF attempt for the same work, which is a different and entirely untried route.
 *
 * `retry_after` is a STAMP, not a policy the query re-derives. Computing the cooldown in SQL from
 * `attempts` would put the escalation curve inside a `whereRaw` that every selection query must
 * keep identical, and make "retry that one now" an interval-arithmetic puzzle instead of a single
 * `DELETE FROM harvest_attempts WHERE …`. Policy lives in HarvestAttemptRecorder; the queries only
 * ask whether the stamp has passed.
 */
return new class extends Migration
{
    public function up(): void
    {
        $appUser = env('DB_USERNAME', 'hyperlit_app');

        DB::connection('pgsql_admin')->statement("
            CREATE TABLE harvest_attempts (
                canonical_source_id uuid NOT NULL REFERENCES canonical_source(id) ON DELETE CASCADE,
                lane varchar(20) NOT NULL,

                attempts integer NOT NULL DEFAULT 0,
                retry_after timestamptz NULL,
                last_failure text NULL,

                created_at timestamptz NOT NULL DEFAULT NOW(),
                updated_at timestamptz NOT NULL DEFAULT NOW(),

                PRIMARY KEY (canonical_source_id, lane)
            )
        ");

        // The selection queries join this table and ask 'has the stamp passed?'. A row exists only
        // for a work that has actually failed, so this index stays small however big the corpus.
        DB::connection('pgsql_admin')->statement(
            'CREATE INDEX harvest_attempts_lane_retry_idx ON harvest_attempts (lane, retry_after)'
        );

        DB::connection('pgsql_admin')->statement(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON harvest_attempts TO {$appUser}"
        );
    }

    public function down(): void
    {
        DB::connection('pgsql_admin')->statement('DROP TABLE IF EXISTS harvest_attempts');
    }
};
