<?php

/**
 * HarvestEligibility::eligibleCanonicalsForJournal / estimateForJournal —
 * the journal-rooted twin of the book-rooted predicate. Pure SQL over
 * canonical_source, seeded + cleaned via pgsql_admin (prefix JElig).
 */

use App\Services\SourceHarvest\HarvestEligibility;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function jeligDb()
{
    return DB::connection('pgsql_admin');
}

function jeligCleanup(): void
{
    jeligDb()->table('canonical_source')->where('title', 'LIKE', 'JElig %')->delete();
}

beforeEach(fn() => jeligCleanup());
afterEach(fn() => jeligCleanup());

function jeligSeed(?string $journalId, array $opts = []): string
{
    $id = (string) Str::uuid();
    jeligDb()->table('canonical_source')->insert(array_merge([
        'id'                => $id,
        'title'             => 'JElig ' . Str::random(6),
        'journal_source_id' => $journalId,
        'is_oa'             => true,
        'pdf_url'           => 'https://example.org/jelig.pdf',
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $opts));
    return $id;
}

test('predicate: journal-scoped, unharvested, OA, fetchable', function () {
    $journalId = (string) Str::uuid();
    $otherJournal = (string) Str::uuid();

    $eligiblePdf = jeligSeed($journalId, ['cited_by_count' => 50]);
    $eligibleOaUrl = jeligSeed($journalId, ['pdf_url' => null, 'oa_url' => 'https://example.org/x', 'cited_by_count' => 40]);
    $eligibleDoi = jeligSeed($journalId, ['pdf_url' => null, 'doi' => '10.9999/jelig', 'cited_by_count' => null]);

    jeligSeed($journalId, ['auto_version_book' => 'book_jelig_done']);          // already harvested
    jeligSeed($journalId, ['is_oa' => false]);                                   // not OA
    jeligSeed($journalId, ['is_oa' => null]);                                    // OA unknown
    jeligSeed($journalId, ['pdf_url' => '']);                                    // nothing fetchable
    jeligSeed($otherJournal);                                                    // different journal
    jeligSeed(null, []);                                                         // no journal at all

    $rows = app(HarvestEligibility::class)->eligibleCanonicalsForJournal($journalId);

    // Most-cited first, null citations last.
    expect($rows->pluck('id')->all())->toBe([$eligiblePdf, $eligibleOaUrl, $eligibleDoi]);

    // Limit caps.
    expect(app(HarvestEligibility::class)->eligibleCanonicalsForJournal($journalId, 2))->toHaveCount(2);
});

test('estimateForJournal counts total / eligible / cooling_off / already_harvested', function () {
    $journalId = (string) Str::uuid();

    jeligSeed($journalId, ['cited_by_count' => 5]);
    jeligSeed($journalId, ['auto_version_book' => 'book_jelig_done']);
    jeligSeed($journalId, ['is_oa' => false]);

    $estimate = app(HarvestEligibility::class)->estimateForJournal($journalId);

    expect($estimate)->toBe([
        'total'             => 3,
        'eligible'          => 1,
        'cooling_off'       => 0,
        'already_harvested' => 1,
    ]);
});

/**
 * The retry backoff. Without it a failing work stays eligible on identical terms forever and, since
 * the queue is most-cited-first, re-runs at the FRONT of every batch — which is what made a
 * time-boxed harvest of a big journal unable to ever reach its tail.
 */
test('a work in its cooldown drops out of eligible and is reported as cooling off', function () {
    $journalId = (string) Str::uuid();

    $healthy = jeligSeed($journalId, ['cited_by_count' => 10]);
    $failing = jeligSeed($journalId, ['cited_by_count' => 9000]);   // far more cited: normally first

    app(\App\Services\SourceHarvest\HarvestAttemptRecorder::class)
        ->recordFailure($failing, \App\Services\SourceHarvest\HarvestAttemptRecorder::LANE_PDF, 'navigation_failed');

    $eligibility = app(HarvestEligibility::class);

    expect($eligibility->eligibleCanonicalsForJournal($journalId)->pluck('id')->all())->toBe([$healthy]);

    $estimate = $eligibility->estimateForJournal($journalId);
    expect($estimate['eligible'])->toBe(1);
    expect($estimate['cooling_off'])->toBe(1);
});

test('a cooled-off repeat failure returns BEHIND never-attempted works, not ahead of them', function () {
    $journalId = (string) Str::uuid();

    $untried = jeligSeed($journalId, ['cited_by_count' => 1]);
    $recovered = jeligSeed($journalId, ['cited_by_count' => 9000]);

    // Failed once, but its cooldown has already expired — eligible again, yet it must not reclaim
    // the head of the queue on citations alone. That reordering is most of the original bug.
    jeligDb()->table('harvest_attempts')->insert([
        'canonical_source_id' => $recovered,
        'lane'                => \App\Services\SourceHarvest\HarvestAttemptRecorder::LANE_PDF,
        'attempts'            => 1,
        'retry_after'         => now()->subHour(),
        'created_at'          => now(),
        'updated_at'          => now(),
    ]);

    expect(app(HarvestEligibility::class)->eligibleCanonicalsForJournal($journalId)->pluck('id')->all())
        ->toBe([$untried, $recovered]);
});

test('a success clears the backoff so the work is immediately selectable again', function () {
    $journalId = (string) Str::uuid();
    $work = jeligSeed($journalId, ['cited_by_count' => 5]);

    $recorder = app(\App\Services\SourceHarvest\HarvestAttemptRecorder::class);
    $lane = \App\Services\SourceHarvest\HarvestAttemptRecorder::LANE_PDF;

    $recorder->recordFailure($work, $lane, 'fetch_failed');
    expect(app(HarvestEligibility::class)->eligibleCanonicalsForJournal($journalId))->toHaveCount(0);
    expect($recorder->isCoolingOff($work, $lane))->toBeTrue();

    $recorder->recordSuccess($work, $lane);
    expect(app(HarvestEligibility::class)->eligibleCanonicalsForJournal($journalId))->toHaveCount(1);
    expect($recorder->isCoolingOff($work, $lane))->toBeFalse();
});

test('the two lanes back off independently — an HTML failure never suppresses the PDF attempt', function () {
    $journalId = (string) Str::uuid();
    $work = jeligSeed($journalId, ['cited_by_count' => 5]);

    $recorder = app(\App\Services\SourceHarvest\HarvestAttemptRecorder::class);
    $recorder->recordFailure($work, \App\Services\SourceHarvest\HarvestAttemptRecorder::LANE_HTML, 'no article body');

    // The publisher page being unfetchable says nothing about the PDF, which is a different route
    // to the same article — the html-first strategy depends on exactly this.
    expect(app(HarvestEligibility::class)->eligibleCanonicalsForJournal($journalId))->toHaveCount(1);
    expect($recorder->isCoolingOff($work, \App\Services\SourceHarvest\HarvestAttemptRecorder::LANE_PDF))->toBeFalse();
});

test('backoff escalates with consecutive failures', function () {
    $recorder = app(\App\Services\SourceHarvest\HarvestAttemptRecorder::class);

    // The curve is front-loaded (publisher intermittency recovers fast) and long-tailed (a work
    // that has failed five times is structurally broken and re-fetching it is the toll we stopped
    // paying). Asserted as monotonic rather than by exact hours, so tuning it stays cheap.
    $first = $recorder->retryAfterFor(1);
    $third = $recorder->retryAfterFor(3);
    $sixth = $recorder->retryAfterFor(6);

    expect($first->lessThan($third))->toBeTrue();
    expect($third->lessThan($sixth))->toBeTrue();
    // Past the end of the curve the last value repeats — never permanently retired.
    expect($recorder->retryAfterFor(99)->diffInMinutes($sixth, absolute: true))->toBeLessThan(2);
});
