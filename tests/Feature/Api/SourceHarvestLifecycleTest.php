<?php

/**
 * Source Network Harvester lifecycle over HTTP — the machinery behind the
 * "Import Knowledge Network" creator-tools button. Locks: the owner gate
 * (unlike the citation pipeline, estimate/trigger are 403 for non-owners),
 * the pure-SQL estimate math, trigger concurrency (against both a running
 * harvest AND a running citation pipeline), the encrypted-book 422, stale
 * auto-fail, and the status/running poll contracts.
 */

use App\Jobs\SourceNetworkHarvestJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

function harvDb()
{
    return DB::connection('pgsql_admin');
}

function harvSeedCanonical(array $opts = []): string
{
    $id = (string) Str::uuid();
    harvDb()->table('canonical_source')->insert(array_merge([
        'id'                => $id,
        'title'             => 'HarvTest Canonical ' . Str::random(6),
        'author'            => 'Harv Author',
        'year'              => 2020,
        'is_oa'             => true,
        'pdf_url'           => 'https://example.org/harvtest.pdf',
        'auto_version_book' => null,
        'foundation_source' => 'test',
        'created_at'        => now(),
        'updated_at'        => now(),
    ], $opts));
    return $id;
}

function harvSeedBibEntry(string $book, array $opts = []): void
{
    harvDb()->table('bibliography')->insert(array_merge([
        'book'        => $book,
        'referenceId' => 'harv' . Str::random(8),
        'content'     => 'HarvTest entry content',
        'created_at'  => now(),
        'updated_at'  => now(),
    ], $opts));
}

function harvSeedHarvest(string $book, array $opts = []): string
{
    $id = (string) Str::uuid();
    harvDb()->table('source_network_harvests')->insert(array_merge([
        'id'            => $id,
        'root_book'     => $book,
        'status'        => 'running',
        'max_depth'     => 1,
        'max_works'     => 25,
        'frontier'      => json_encode([]),
        'visited_books' => json_encode([]),
        'counts'        => json_encode([]),
        'telemetry'     => json_encode([]),
        'created_at'    => now(),
        'updated_at'    => now(),
    ], $opts));
    return $id;
}

afterEach(function () {
    harvDb()->table('source_network_harvests')->where('root_book', 'like', 'apitest\_%')->delete();
    harvDb()->table('bibliography')->where('book', 'like', 'apitest\_%')->delete();
    harvDb()->table('canonical_source')->where('title', 'like', 'HarvTest %')->delete();
    harvDb()->table('shelves')->where('name', 'like', 'Harvested from: APITEST%')->delete();
    $this->cleanupApiFixtures();
});

// ── Owner gate ─────────────────────────────────────────────────────

test('estimate and trigger are 403 for a non-owner of a public book', function () {
    Queue::fake();

    $owner = $this->loginUser();
    $book = $this->makeBook($owner, ['visibility' => 'public']);

    // Log in as somebody else
    $this->loginUser();

    $this->assertApiError($this->postJson("/api/library/{$book}/harvest/estimate"), 403);
    $this->assertApiError($this->postJson("/api/library/{$book}/harvest/trigger"), 403);
    Queue::assertNothingPushed();
});

test('a private book is invisible (404) to a non-owner — RLS hides it before the owner check', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner); // private by default

    $this->loginUser();

    $this->assertApiError($this->postJson("/api/library/{$book}/harvest/estimate"), 404);
});

test('estimate 404s for an unknown book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/library/apitest_nope/harvest/estimate'), 404);
});

// ── Estimate math ──────────────────────────────────────────────────

test('estimate counts resolved, unresolved, eligible and already-harvested citations', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    // Two resolved entries pointing at eligible OA canonicals
    harvSeedBibEntry($book, ['canonical_source_id' => harvSeedCanonical()]);
    harvSeedBibEntry($book, ['canonical_source_id' => harvSeedCanonical(['pdf_url' => null, 'oa_url' => 'https://example.org/harv-oa'])]);
    // One resolved entry whose canonical is already harvested
    harvSeedBibEntry($book, ['canonical_source_id' => harvSeedCanonical(['auto_version_book' => 'apitest_alreadyv'])]);
    // One resolved entry that is closed access (not eligible)
    harvSeedBibEntry($book, ['canonical_source_id' => harvSeedCanonical(['is_oa' => false])]);
    // One unresolved entry
    harvSeedBibEntry($book);

    $resp = $this->postJson("/api/library/{$book}/harvest/estimate")->assertOk();

    expect($resp->json('estimate.total_entries'))->toBe(5);
    expect($resp->json('estimate.resolved'))->toBe(4);
    expect($resp->json('estimate.unresolved'))->toBe(1);
    expect($resp->json('estimate.eligible'))->toBe(2);
    expect($resp->json('estimate.already_harvested'))->toBe(1);
    expect($resp->json('max_works'))->toBeGreaterThan(0);
    expect($resp->json('running'))->toBeNull();
});

// ── Trigger ────────────────────────────────────────────────────────

test('trigger creates a harvest row seeded with the root frontier and queues the job', function () {
    Queue::fake();

    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);

    $resp = $this->postJson("/api/library/{$book}/harvest/trigger")->assertOk();
    $harvestId = $resp->json('harvest_id');
    expect($harvestId)->not->toBeNull();

    Queue::assertPushed(SourceNetworkHarvestJob::class);

    $row = harvDb()->table('source_network_harvests')->where('id', $harvestId)->first();
    expect($row->status)->toBe('pending');
    expect($row->root_book)->toBe($book);
    expect(json_decode($row->frontier, true))->toBe([['book' => $book, 'depth' => 0]]);
    expect($row->max_works)->toBeGreaterThan(0);
});

test('triggering while a harvest is already running returns 409', function () {
    Queue::fake();

    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);
    harvSeedHarvest($book, ['status' => 'running', 'updated_at' => now()]);

    $this->assertApiError($this->postJson("/api/library/{$book}/harvest/trigger"), 409);
    Queue::assertNothingPushed();
});

test('triggering while a citation pipeline is running for the book returns 409', function () {
    Queue::fake();

    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);
    harvDb()->table('citation_pipelines')->insert([
        'id'         => (string) Str::uuid(),
        'book'       => $book,
        'status'     => 'running',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $this->assertApiError($this->postJson("/api/library/{$book}/harvest/trigger"), 409);
    Queue::assertNothingPushed();
});

test('an encrypted book cannot be harvested (server only holds ciphertext)', function () {
    Queue::fake();

    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user, ['encrypted' => true]);

    $this->assertApiError($this->postJson("/api/library/{$book}/harvest/trigger"), 422);
    Queue::assertNothingPushed();
});

// ── Status / running polls ─────────────────────────────────────────

test('status returns counts and the telemetry event stream', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book, [
        'step'        => 'harvest',
        'step_detail' => 'Importing work 2/5',
        'counts'      => json_encode(['attempted' => 2, 'assigned' => 1]),
        'telemetry'   => json_encode([
            ['stage' => 'scan', 'status' => 'completed', 'at' => now()->toDateTimeString()],
            ['stage' => 'harvest', 'status' => 'progress', 'detail' => '2/5: Some Work — assigned', 'at' => now()->toDateTimeString()],
        ]),
    ]);

    $this->getJson("/api/source-harvest/status/{$id}")
        ->assertOk()
        ->assertJsonPath('harvest.step', 'harvest')
        ->assertJsonPath('harvest.step_detail', 'Importing work 2/5')
        ->assertJsonPath('harvest.counts.assigned', 1)
        ->assertJsonPath('harvest.telemetry.0.stage', 'scan')
        ->assertJsonPath('harvest.telemetry.1.detail', '2/5: Some Work — assigned');
});

test('running endpoint reports the active harvest for panel-reopen restore', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book, ['step_detail' => 'Scanning bibliography (depth 0)']);

    $this->getJson("/api/source-harvest/running/{$book}")
        ->assertOk()
        ->assertJsonPath('harvest.id', $id)
        ->assertJsonPath('harvest.step_detail', 'Scanning bibliography (depth 0)');
});

// ── Map + shelf payload ────────────────────────────────────────────

test('the map endpoint returns the harvest stage chain', function () {
    $this->loginUser();

    $stages = $this->getJson('/api/source-harvest/map')->assertOk()->json('stages');
    expect(array_column($stages, 'id'))->toBe(['scan', 'select', 'harvest', 'shelf']);
    foreach ($stages as $stage) {
        expect($stage['plain'])->not->toBeEmpty();
        expect($stage['code_ref'])->not->toBeEmpty();
    }
});

test('status carries the shelf link once the shelf step has run', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);

    $shelfId = (string) Str::uuid();
    harvDb()->table('shelves')->insert([
        'id'           => $shelfId,
        'creator'      => $user->name,
        'name'         => 'Harvested from: APITEST Root',
        'slug'         => 'harvested-from-apitest-root',
        'visibility'   => 'private',
        'default_sort' => 'recent',
        'created_at'   => now(),
        'updated_at'   => now(),
    ]);
    $id = harvSeedHarvest($book, ['status' => 'completed', 'shelf_id' => $shelfId]);

    $this->getJson("/api/source-harvest/status/{$id}")
        ->assertOk()
        ->assertJsonPath('harvest.shelf.slug', 'harvested-from-apitest-root')
        ->assertJsonPath('harvest.shelf.creator', $user->name);
});

test('status shelf is null before the shelf step runs', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book);

    $this->getJson("/api/source-harvest/status/{$id}")
        ->assertOk()
        ->assertJsonPath('harvest.shelf', null);
});

// ── Email-when-done notify endpoint ────────────────────────────────

test('notify requires authentication', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book);

    // Fresh guest session
    app('auth')->guard('web')->logout();
    $this->post("/api/source-harvest/{$id}/notify")->assertStatus(401);
});

test('notify is 403 for a non-owner and 200 (sets the flag) for the owner', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner);
    $id = harvSeedHarvest($book, ['user_id' => $owner->id]);

    // Someone else
    $this->loginUser();
    $this->postJson("/api/source-harvest/{$id}/notify")->assertStatus(403);
    expect((bool) harvDb()->table('source_network_harvests')->where('id', $id)->value('notify_email'))->toBeFalse();

    // The owner
    $this->actingAs($owner);
    $this->postJson("/api/source-harvest/{$id}/notify")->assertOk();
    expect((bool) harvDb()->table('source_network_harvests')->where('id', $id)->value('notify_email'))->toBeTrue();
});

test('notify is 422 once the harvest has finished', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book, ['user_id' => $user->id, 'status' => 'completed']);

    $this->postJson("/api/source-harvest/{$id}/notify")->assertStatus(422);
});

test('notify is 404 for an unknown harvest', function () {
    $this->loginUser();
    $this->postJson('/api/source-harvest/' . Str::uuid() . '/notify')->assertStatus(404);
});

// ── Stale auto-fail ────────────────────────────────────────────────

test('a harvest stuck in pending for over 5 minutes is auto-failed by the status poll', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book, ['status' => 'pending', 'updated_at' => now()->subMinutes(10)]);

    $this->getJson("/api/source-harvest/status/{$id}")
        ->assertOk()
        ->assertJsonPath('harvest.status', 'failed');

    expect(harvDb()->table('source_network_harvests')->where('id', $id)->value('error'))
        ->toContain('stuck in pending');
});

test('a harvest with no progress for over 3 hours is auto-failed and unblocks a new trigger', function () {
    Queue::fake();

    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);
    harvSeedHarvest($book, ['status' => 'running', 'updated_at' => now()->subHours(4)]);

    $this->postJson("/api/library/{$book}/harvest/trigger")->assertOk();
    Queue::assertPushed(SourceNetworkHarvestJob::class);
});

test('a fresh running harvest is left alone', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book, ['status' => 'running', 'updated_at' => now()]);

    $this->getJson("/api/source-harvest/status/{$id}")
        ->assertOk()
        ->assertJsonPath('harvest.status', 'running');
});
