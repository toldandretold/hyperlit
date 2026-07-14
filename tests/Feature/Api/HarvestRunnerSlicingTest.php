<?php

/**
 * HarvestRunner sliced execution + crash finalization. The runner owns: ending
 * a run at the slice budget with a resume bookmark (instead of running
 * unbounded), resuming a parked batch without re-scanning, and rebuilding the
 * shelf + yield report wholly from the row's persisted state so a crashed job
 * still ships a partial-marked report (SourceNetworkHarvestJob::failed →
 * finalize). Mocked seams as in HarvestRunnerBillingTest — this drives only
 * the control flow.
 */

use App\Jobs\SourceNetworkHarvestJob;
use App\Services\BillingService;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\SourceHarvest\HarvestEligibility;
use App\Services\SourceHarvest\HarvestRunner;
use App\Services\SourceHarvest\HarvestShelf;
use App\Services\SourceHarvest\YieldReportBook;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function hslcDb()
{
    return DB::connection('pgsql_admin');
}

function hslcSeedHarvest(string $book, int $userId, array $opts = []): string
{
    $id = (string) Str::uuid();
    hslcDb()->table('source_network_harvests')->insert(array_merge([
        'id'            => $id,
        'root_book'     => $book,
        'user_id'       => $userId,
        'status'        => 'running',
        'max_depth'     => 1,
        'max_works'     => 25,
        'frontier'      => json_encode([['book' => $book, 'depth' => 0]]),
        'visited_books' => json_encode([]),
        'counts'        => json_encode([]),
        'telemetry'     => json_encode([]),
        'created_at'    => now(),
        'updated_at'    => now(),
    ], $opts));
    return $id;
}

/** Seed N real canonical rows (CanonicalSource::find must resolve them) + return the eligible-row shape. */
function hslcSeedEligible(int $n): \Illuminate\Support\Collection
{
    return collect(range(1, $n))->map(function ($i) {
        $id = (string) Str::uuid();
        hslcDb()->table('canonical_source')->insert([
            'id'                => $id,
            'title'             => "HSlc Canonical {$i}",
            'author'            => 'Slice Author',
            'year'              => 2021,
            'is_oa'             => true,
            'pdf_url'           => 'https://example.org/hslc.pdf',
            'foundation_source' => 'test',
            'created_at'        => now(),
            'updated_at'        => now(),
        ]);
        return (object) [
            'id' => $id, 'title' => "HSlc Canonical {$i}", 'author' => 'Slice Author',
            'year' => 2021, 'journal' => null, 'publisher' => null, 'type' => 'article',
            'doi' => null, 'openalex_id' => null, 'oa_url' => null, 'pdf_url' => 'https://example.org/hslc.pdf',
        ];
    });
}

afterEach(function () {
    hslcDb()->table('source_network_harvests')->where('root_book', 'like', 'apitest\_%')->delete();
    hslcDb()->table('canonical_source')->where('title', 'like', 'HSlc %')->delete();
    $this->cleanupApiFixtures();
});

test('run ends at the slice budget with a resume bookmark instead of finalizing', function () {
    // Sub-second slice: the deadline is past by the first check AFTER the scan
    // (the progress guard makes the scan the slice's one unit of work), so the
    // whole batch parks as resume_ids and nothing is attempted.
    config(['source_harvest.slice_seconds' => 0.0001, 'source_harvest.sleep_between_works' => 0]);
    $user = $this->loginUser(['status' => 'budget']);
    $book = $this->makeBook($user);
    $eligible = hslcSeedEligible(3);
    $id = hslcSeedHarvest($book, $user->id);

    Artisan::shouldReceive('call')->once()->andReturn(0);
    $this->mock(HarvestEligibility::class, fn ($m) => $m->shouldReceive('eligibleCanonicalsFor')->andReturn($eligible));
    $this->mock(AutoVersionCreator::class, fn ($m) => $m->shouldReceive('create')->never());
    // A slice must NOT finalize — no shelf, no report.
    $this->mock(HarvestShelf::class, fn ($m) => $m->shouldReceive('ensureShelfFor')->never());
    $this->mock(YieldReportBook::class, fn ($m) => $m->shouldReceive('generate')->never());
    $this->mock(BillingService::class, function ($m) {
        $m->shouldReceive('canProceed')->andReturn(true);
        $m->shouldReceive('billOcrForBook')->never();
    });

    $outcome = app(HarvestRunner::class)->run($id);

    expect($outcome)->toBe('sliced');
    $row = hslcDb()->table('source_network_harvests')->where('id', $id)->first();
    $frontier = json_decode($row->frontier, true);
    expect($frontier[0]['book'])->toBe($book);
    expect($frontier[0]['resume_ids'])->toHaveCount(3);
    expect(json_decode($row->counts, true)['attempted'] ?? 0)->toBe(0);
    expect($row->status)->toBe('running'); // the runner never flips status — the job does
});

test('a resume slice continues the parked batch without re-scanning and finalizes at the end', function () {
    config(['source_harvest.slice_seconds' => 0, 'source_harvest.sleep_between_works' => 0]); // slicing off → run to the end
    $user = $this->loginUser(['status' => 'budget']);
    $book = $this->makeBook($user);
    $eligible = hslcSeedEligible(3);
    // Pretend slice 1 attempted work #1 and parked #2/#3.
    $id = hslcSeedHarvest($book, $user->id, [
        'frontier'      => json_encode([[
            'book' => $book, 'depth' => 0,
            'resume_ids' => $eligible->slice(1)->pluck('id')->values()->all(),
        ]]),
        'visited_books' => json_encode([$book]),
        'counts'        => json_encode(['attempted' => 1, 'assigned' => 1, 'eligible' => 3]),
    ]);

    Artisan::shouldReceive('call')->never(); // resume must not re-run the bibliography scan
    $this->mock(HarvestEligibility::class, fn ($m) => $m->shouldReceive('eligibleCanonicalsFor')->andReturn($eligible));
    $this->mock(AutoVersionCreator::class, fn ($m) => $m->shouldReceive('create')->twice()->andReturn([
        'status' => 'assigned', 'book' => 'apitest_hslc_v' . Str::random(5), 'reason' => null, 'via' => null, 'lane' => null,
    ]));
    $this->mock(HarvestShelf::class, fn ($m) => $m->shouldReceive('ensureShelfFor')->once()->andReturnNull());
    $this->mock(BillingService::class, function ($m) {
        $m->shouldReceive('canProceed')->andReturn(true);
        $m->shouldReceive('billOcrForBook')->twice()->andReturn(0.0);
    });

    $outcome = app(HarvestRunner::class)->run($id);

    expect($outcome)->toBe('completed');
    $counts = json_decode(hslcDb()->table('source_network_harvests')->where('id', $id)->value('counts'), true);
    expect($counts['attempted'])->toBe(3);      // 1 from slice 1 + the 2 resumed
    expect($counts['eligible'])->toBe(3);       // NOT re-counted on resume
});

test('the job re-dispatches itself when a slice ends with work remaining', function () {
    Queue::fake();
    $user = $this->loginUser(['status' => 'budget']);
    $book = $this->makeBook($user);
    $id = hslcSeedHarvest($book, $user->id);

    $runner = Mockery::mock(HarvestRunner::class);
    $runner->shouldReceive('run')->once()->with($id)->andReturn('sliced');

    (new SourceNetworkHarvestJob($id))->handle($runner);

    Queue::assertPushed(SourceNetworkHarvestJob::class, 1);
    // Between slices the harvest stays live: 'running' status, no terminal flip.
    expect(hslcDb()->table('source_network_harvests')->where('id', $id)->value('status'))->toBe('running');
});

test('a crashed job still finalizes the shelf + yield report, marked partial', function () {
    $user = $this->loginUser(['status' => 'budget']);
    $book = $this->makeBook($user);
    $shelfId = (string) Str::uuid();
    // A run that persisted one assigned work, then died before finalize.
    $id = hslcSeedHarvest($book, $user->id, [
        'counts'  => json_encode(['attempted' => 1, 'assigned' => 1]),
        'results' => json_encode([[
            'canonical_source_id' => (string) Str::uuid(),
            'title' => 'HSlc Partial', 'status' => 'assigned',
            'book' => 'apitest_hslc_partial', 'depth' => 1, 'parent_book' => $book,
        ]]),
    ]);

    $this->mock(HarvestShelf::class, function ($m) use ($shelfId) {
        $m->shouldReceive('ensureShelfFor')->once()
            ->andReturn((object) ['id' => $shelfId, 'name' => 'x', 'slug' => 'x', 'creator' => 'x']);
        // The assigned book (derived from persisted results) + the report get shelved.
        $m->shouldReceive('addBooks')->once()
            ->withArgs(fn ($sid, $books) => $sid === $shelfId
                && in_array('apitest_hslc_partial', $books, true)
                && in_array('apitest_hslc_report', $books, true));
    });
    $this->mock(YieldReportBook::class, fn ($m) => $m->shouldReceive('generate')->once()
        ->withArgs(fn ($root, $title, $results, $note) => $root === $book
            && count($results) === 1
            && str_contains((string) $note, 'died partway'))
        ->andReturn('apitest_hslc_report'));

    (new SourceNetworkHarvestJob($id))->failed(new RuntimeException('boom'));

    $row = hslcDb()->table('source_network_harvests')->where('id', $id)->first();
    expect($row->status)->toBe('failed');
    expect($row->report_book)->toBe('apitest_hslc_report');
    expect($row->shelf_id)->toBe($shelfId);
});
