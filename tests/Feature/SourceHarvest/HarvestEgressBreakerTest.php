<?php

/**
 * The circuit breaker for OUR OWN egress failing mid-harvest.
 *
 * A dead proxy fails every work identically, which turns the retry backoff from a protection into
 * a liability: each article spends its cooldown on a fault it had no part in, so when the proxy
 * comes back the whole journal is invisible for an hour — and a self-continuing chain would walk
 * the entire corpus doing it, at up to 75s of browser process timeout per doomed work.
 *
 * Observed on tripleC (2026-09-11): 37 works, both lanes, a single uniform
 * `net::ERR_TUNNEL_CONNECTION_FAILED`.
 *
 * AutoVersionCreator is container-mocked (its real body hits the network). Canonicals are seeded
 * through pgsql_admin because that is the connection HarvestEligibility selects on.
 */

use App\Models\JournalSource;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\JournalHarvest\JournalHarvestRunner;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function ebDb()
{
    return DB::connection('pgsql_admin');
}

function ebCleanup(): void
{
    $ids = ebDb()->table('canonical_source')->where('title', 'LIKE', 'EBreak %')->pluck('id');
    if ($ids->isNotEmpty()) {
        ebDb()->table('harvest_attempts')->whereIn('canonical_source_id', $ids)->delete();
    }
    ebDb()->table('canonical_source')->where('title', 'LIKE', 'EBreak %')->delete();
    ebDb()->table('journal_sources')->where('openalex_source_id', 'LIKE', 'SEBREAK%')->delete();
}

beforeEach(fn() => ebCleanup());

function ebSeedJournal(): JournalSource
{
    $id = (string) Str::uuid();
    ebDb()->table('journal_sources')->insert([
        'id'                 => $id,
        'openalex_source_id' => 'SEBREAK1',
        'display_name'       => 'EBreak Journal',
        'slug'               => 'ebreak-journal-' . Str::lower(Str::random(6)),
        'is_diamond'         => true,
        'created_at'         => now(),
        'updated_at'         => now(),
    ]);

    return JournalSource::on('pgsql_admin')->find($id);
}

function ebSeedWorks(string $journalId, int $count): void
{
    for ($i = 0; $i < $count; $i++) {
        ebDb()->table('canonical_source')->insert([
            'id'                => (string) Str::uuid(),
            'title'             => 'EBreak Work ' . $i,
            'journal_source_id' => $journalId,
            'is_oa'             => true,
            'pdf_url'           => "https://example.org/ebreak{$i}.pdf",
            'cited_by_count'    => 100 - $i,
            'created_at'        => now(),
            'updated_at'        => now(),
        ]);
    }
}

test('consecutive egress failures abort the run instead of working through the journal', function () {
    $journal = ebSeedJournal();
    ebSeedWorks($journal->id, 20);

    $attempted = 0;
    $this->mock(AutoVersionCreator::class, function ($m) use (&$attempted) {
        $m->shouldReceive('create')->andReturnUsing(function () use (&$attempted) {
            $attempted++;

            return [
                'status' => 'fetch_failed',
                'book'   => null,
                'lane'   => null,
                'reason' => 'Browser fetch failed: navigation_failed — net::ERR_TUNNEL_CONNECTION_FAILED',
            ];
        });
    });

    $run = app(JournalHarvestRunner::class)->importPdfLanes($journal, 0, null, false, 0);

    // Five to establish the outage, then it stops — NOT all 20. That difference is the whole
    // point: at ~75s of browser timeout apiece, 890 works would be a day of burning nothing.
    expect($attempted)->toBe(5);
    expect($run['aborted_reason'])->toContain('our own network egress');
    expect($run['stopped_early'])->toBeFalse();
});

test('an egress failure never spends the work retry budget', function () {
    $journal = ebSeedJournal();
    ebSeedWorks($journal->id, 8);

    $this->mock(AutoVersionCreator::class, fn ($m) => $m->shouldReceive('create')->andReturn([
        'status' => 'fetch_failed',
        'book'   => null,
        'lane'   => null,
        'reason' => 'Browser fetch failed: navigation_failed — net::ERR_TUNNEL_CONNECTION_FAILED',
    ]));

    app(JournalHarvestRunner::class)->importPdfLanes($journal, 0, null, false, 0);

    // Nothing in cooldown: the queue must be exactly as it was, so fixing the proxy and pressing
    // again resumes rather than waiting an hour for works that were never fairly tried.
    $ids = ebDb()->table('canonical_source')->where('journal_source_id', $journal->id)->pluck('id');
    expect(ebDb()->table('harvest_attempts')->whereIn('canonical_source_id', $ids)->count())->toBe(0);
    expect(app(\App\Services\SourceHarvest\HarvestEligibility::class)
        ->estimateForJournal($journal->id)['eligible'])->toBe(8);
});

test('a publisher failure still backs off, and resets the egress counter', function () {
    $journal = ebSeedJournal();
    ebSeedWorks($journal->id, 8);

    // Alternating egress / publisher failures: the breaker counts CONSECUTIVE egress faults, so an
    // intermittent proxy blip between real failures must never look like an outage.
    $n = 0;
    $this->mock(AutoVersionCreator::class, function ($m) use (&$n) {
        $m->shouldReceive('create')->andReturnUsing(function () use (&$n) {
            $n++;

            return [
                'status' => 'fetch_failed',
                'book'   => null,
                'lane'   => null,
                'reason' => $n % 2 === 0
                    ? 'Browser fetch failed: navigation_failed — net::ERR_TUNNEL_CONNECTION_FAILED'
                    : 'no article body — only 1 prose paragraph(s) / 400 chars',
            ];
        });
    });

    $run = app(JournalHarvestRunner::class)->importPdfLanes($journal, 0, null, false, 0);

    expect($run['aborted_reason'])->toBeNull();
    expect($n)->toBe(8);

    // Only the publisher failures took a cooldown.
    $ids = ebDb()->table('canonical_source')->where('journal_source_id', $journal->id)->pluck('id');
    expect(ebDb()->table('harvest_attempts')->whereIn('canonical_source_id', $ids)->count())->toBe(4);
});
