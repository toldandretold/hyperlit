<?php

/**
 * HarvestRunner billing + spend-cap + cancel control flow. The runner itself
 * (not the HTTP seam) owns: charging each freshly-imported work's OCR, stopping
 * gracefully once the spend cap is reached (recording the remainder as
 * over-budget), and stopping on a cancel request. We mock the injected services
 * so the test drives only that control flow — the real OCR pricing lives in
 * BillingService::billOcrForBook (its own tests).
 */

use App\Services\BillingService;
use App\Services\CanonicalVersions\AutoVersionCreator;
use App\Services\SourceHarvest\HarvestEligibility;
use App\Services\SourceHarvest\HarvestRunner;
use App\Services\SourceHarvest\HarvestShelf;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function hrunDb()
{
    return DB::connection('pgsql_admin');
}

function hrunSeedHarvest(string $book, int $userId, array $opts = []): string
{
    $id = (string) Str::uuid();
    hrunDb()->table('source_network_harvests')->insert(array_merge([
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
function hrunSeedEligible(int $n): \Illuminate\Support\Collection
{
    return collect(range(1, $n))->map(function ($i) {
        $id = (string) Str::uuid();
        hrunDb()->table('canonical_source')->insert([
            'id'                => $id,
            'title'             => "HRun Canonical {$i}",
            'author'            => 'Harv Author',
            'year'              => 2020,
            'is_oa'             => true,
            'pdf_url'           => 'https://example.org/hrun.pdf',
            'foundation_source' => 'test',
            'created_at'        => now(),
            'updated_at'        => now(),
        ]);
        return (object) [
            'id' => $id, 'title' => "HRun Canonical {$i}", 'author' => 'Harv Author',
            'year' => 2020, 'journal' => null, 'publisher' => null, 'type' => 'article',
            'doi' => null, 'openalex_id' => null, 'oa_url' => null, 'pdf_url' => 'https://example.org/hrun.pdf',
        ];
    });
}

afterEach(function () {
    hrunDb()->table('source_network_harvests')->where('root_book', 'like', 'apitest\_%')->delete();
    hrunDb()->table('canonical_source')->where('title', 'like', 'HRun %')->delete();
    $this->cleanupApiFixtures();
});

test('charges each imported work and stops gracefully at the spend cap', function () {
    $user = $this->loginUser(['status' => 'budget']); // pay-as-you-go → cap applies
    $book = $this->makeBook($user);
    $eligible = hrunSeedEligible(3);
    $id = hrunSeedHarvest($book, $user->id, ['max_spend' => 3.00]);

    // Scan is a no-op; eligibility hands back our three canonicals.
    Artisan::shouldReceive('call')->andReturn(0);
    $this->mock(HarvestEligibility::class, function ($m) use ($eligible) {
        $m->shouldReceive('eligibleCanonicalsFor')->andReturn($eligible);
        $m->shouldReceive('harvestedNetworkFor')->andReturn([]); // finalize's durable query
    });
    $this->mock(AutoVersionCreator::class, fn ($m) => $m->shouldReceive('create')->andReturn([
        'status' => 'assigned', 'book' => 'apitest_hrun_v' . Str::random(5), 'reason' => null, 'via' => null, 'lane' => null,
    ]));
    $this->mock(HarvestShelf::class, fn ($m) => $m->shouldReceive('ensureShelfFor')->andReturnNull());
    // Each imported work "costs" $2 → after 2 works spend hits $4 (> $3 cap), so
    // the 3rd never runs. billOcrForBook is therefore called exactly twice.
    $this->mock(BillingService::class, function ($m) {
        $m->shouldReceive('billOcrForBook')->twice()->andReturn(2.0);
        $m->shouldReceive('canProceed')->andReturn(true);
    });

    $outcome = app(HarvestRunner::class)->run($id);

    expect($outcome)->toBe('completed'); // a budget stop finalizes normally
    $counts = json_decode(hrunDb()->table('source_network_harvests')->where('id', $id)->value('counts'), true);
    expect($counts['attempted'])->toBe(2);
    expect($counts['assigned'])->toBe(2);
    expect($counts['skipped_over_budget'])->toBe(1);
    expect((float) $counts['spend'])->toBe(4.0);
});

test('a cancel request stops the run before any work and returns cancelled', function () {
    $user = $this->loginUser(['status' => 'budget']);
    $book = $this->makeBook($user);
    $id = hrunSeedHarvest($book, $user->id, ['cancel_requested' => true]);

    // The cancel check fires at the frontier top, before scan/select — so the
    // eligibility scan and any charge must never run.
    $this->mock(HarvestEligibility::class, function ($m) {
        $m->shouldReceive('eligibleCanonicalsFor')->never();
        $m->shouldReceive('harvestedNetworkFor')->andReturn([]); // finalize's durable query
    });
    $this->mock(BillingService::class, fn ($m) => $m->shouldReceive('billOcrForBook')->never());
    $this->mock(HarvestShelf::class, fn ($m) => $m->shouldReceive('ensureShelfFor')->andReturnNull());

    $outcome = app(HarvestRunner::class)->run($id);

    expect($outcome)->toBe('cancelled');
    $counts = json_decode(hrunDb()->table('source_network_harvests')->where('id', $id)->value('counts'), true);
    expect($counts['attempted'] ?? 0)->toBe(0);
});
