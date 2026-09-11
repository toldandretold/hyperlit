<?php

namespace App\Services\SourceHarvest;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The single definition of "we tried this work on this lane, here is when to try again".
 *
 * Harvest selection used to have no memory (see the 2026_09_11 migration): a work that failed
 * stayed selectable on identical terms, and since both queues are ordered most-cited-first, the
 * failures — usually high-citation works — re-ran at the FRONT of every subsequent batch. On a
 * journal big enough to need a dozen time-boxed runs that is not a nuisance, it is a wall: the dead
 * set grows each round and eventually consumes the whole budget, so the tail is never reached.
 *
 * Policy lives here and nowhere else. The selection queries only ever ask "has the stamp passed?",
 * so the escalation curve can change without touching any of them, and a human can always overrule
 * it by deleting the row (`forget()`).
 *
 * Deliberately NOT a transactional concern of the import itself: recording an attempt must never
 * fail a fetch that otherwise worked, and a crash between fetch and record just means the work is
 * retried sooner than the curve intended — the safe direction.
 */
class HarvestAttemptRecorder
{
    /** The PDF / acquisition-ladder queue (HarvestEligibility). */
    public const LANE_PDF = 'pdf';

    /** The publisher-HTML queue (HtmlLaneCreator::pendingForJournal). */
    public const LANE_HTML = 'html';

    /**
     * How long to wait after the Nth consecutive failure, in hours.
     *
     * Front-loaded because the commonest failure by far is publisher intermittency — a slow OJS box
     * that timed out the 30s browser navigation is very likely fine an hour later, and an eager
     * first retry costs one fetch. The tail is long because a work that has failed five times is
     * almost always structurally broken (dead OA link, a landing page with no obtainable PDF), and
     * re-attempting those is precisely the toll this class exists to stop paying.
     *
     * Past the end of the curve the last value repeats — a work is never permanently retired, since
     * "the publisher fixed their link" is a real event and nothing else would ever notice it.
     */
    private const BACKOFF_HOURS = [1, 6, 24, 96, 336, 720];

    /**
     * A work was attempted on this lane and failed. Escalates its cooldown and records why.
     *
     * `$reason` is stored verbatim for the operator — it is what lets a console row say what
     * happened instead of making someone re-run a 75s browser fetch to find out.
     */
    public function recordFailure(string $canonicalId, string $lane, ?string $reason = null): void
    {
        $db = DB::connection('pgsql_admin');

        $attempts = 1 + (int) $db->table('harvest_attempts')
            ->where('canonical_source_id', $canonicalId)
            ->where('lane', $lane)
            ->value('attempts');

        $db->table('harvest_attempts')->updateOrInsert(
            ['canonical_source_id' => $canonicalId, 'lane' => $lane],
            [
                'attempts'     => $attempts,
                'retry_after'  => $this->retryAfterFor($attempts),
                'last_failure' => $reason === null ? null : Str::limit($reason, 500),
                'updated_at'   => now(),
            ],
        );
    }

    /**
     * A work came good on this lane. Clears the backoff completely.
     *
     * Called even though a successful PDF import sets `auto_version_book` and so drops out of
     * eligibility anyway: a version can be deleted or a lane demoted later, and a work returning to
     * the queue carrying a stale 30-day cooldown from failures it has since recovered from would be
     * invisible for a month with nothing to explain why.
     */
    public function recordSuccess(string $canonicalId, string $lane): void
    {
        $this->forget($canonicalId, $lane);
    }

    /**
     * Drop the backoff for a work/lane — the operator override.
     *
     * A person who has just fixed the converter, or who can see the publisher is back up, should
     * not have to wait out a curve tuned for unattended batches.
     */
    public function forget(string $canonicalId, string $lane): void
    {
        DB::connection('pgsql_admin')->table('harvest_attempts')
            ->where('canonical_source_id', $canonicalId)
            ->where('lane', $lane)
            ->delete();
    }

    /**
     * Is this work/lane still serving a cooldown?
     *
     * For callers that pick their work list from ONE lane's queue but may act on the other — the
     * html-first mode selects on PDF eligibility and then tries the HTML lane per work, so it has
     * to ask about the HTML cooldown itself rather than getting it from the selection query.
     *
     * The comparison is done IN SQL, the same way the selection queries do it, rather than by
     * parsing the stamp back into PHP. Reading a `timestamptz` into Carbon and asking `isFuture()`
     * re-introduces a timezone round-trip that the queries never perform, so the two could disagree
     * about the same row — and this method exists precisely to stand in for those queries.
     */
    public function isCoolingOff(string $canonicalId, string $lane): bool
    {
        return DB::connection('pgsql_admin')->table('harvest_attempts')
            ->where('canonical_source_id', $canonicalId)
            ->where('lane', $lane)
            ->where('retry_after', '>', now())
            ->exists();
    }

    /** When a work on its `$attempts`-th consecutive failure becomes selectable again. */
    public function retryAfterFor(int $attempts): Carbon
    {
        $index = max(0, min($attempts - 1, count(self::BACKOFF_HOURS) - 1));

        return now()->addHours(self::BACKOFF_HOURS[$index]);
    }
}
