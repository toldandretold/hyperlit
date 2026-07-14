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

/** A commons book: system-owned auto-version, no user owner, public. */
function harvSeedCommonsBook(): string
{
    $book = 'apitest_commons_' . Str::random(8);
    harvDb()->table('library')->insert([
        'book'              => $book,
        'title'            => 'HarvTest Commons Work',
        'creator'          => \App\Services\CanonicalVersions\AutoVersionResolver::CREATOR,
        'creator_token'    => null,
        'visibility'       => 'public',
        'listed'           => false,
        'conversion_method' => 'pdf_ocr_auto_raw',
        'has_nodes'        => true,
        'raw_json'         => json_encode(['book' => $book]),
        'created_at'       => now(),
        'updated_at'       => now(),
    ]);
    return $book;
}

afterEach(function () {
    harvDb()->table('source_network_harvests')->where('root_book', 'like', 'apitest\_%')->delete();
    harvDb()->table('bibliography')->where('book', 'like', 'apitest\_%')->delete();
    harvDb()->table('canonical_source')->where('title', 'like', 'HarvTest %')->delete();
    harvDb()->table('shelves')->where('name', 'like', 'Harvested from: APITEST%')->delete();
    harvDb()->table('library')->where('book', 'like', 'apitest\_commons\_%')->delete();
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

// ── Commons-book workflow access (requester-pays, everyone benefits) ─

test('any logged-in user (non-owner) can estimate + trigger on a commons book', function () {
    Queue::fake();
    $book = harvSeedCommonsBook(); // owner = canonicalizer_v1 (no user)

    // A random logged-in user — not the owner (premium so the balance gate passes).
    $this->loginUser(['status' => 'premium']);

    $this->postJson("/api/library/{$book}/harvest/estimate")->assertOk();
    $id = $this->postJson("/api/library/{$book}/harvest/trigger", ['depth' => 1])->assertOk()->json('harvest_id');
    expect($id)->not->toBeNull();
    // The harvest is attributed to the requester, not the system.
    expect((int) harvDb()->table('source_network_harvests')->where('id', $id)->value('user_id'))->toBe((int) auth()->id());
    Queue::assertPushed(SourceNetworkHarvestJob::class);
});

test('a guest cannot run a workflow on a commons book (401)', function () {
    $book = harvSeedCommonsBook();
    // No login.
    $this->assertApiError($this->postJson("/api/library/{$book}/harvest/estimate"), 401);
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

test('estimate returns a rough OCR cost, priced with the caller tier', function () {
    // Pre-OCR estimates price at the PINNED production model (no served id yet)
    // via BillingService::ocrPricePerKPages(null) — pin both here so the math
    // is self-contained.
    config(['services.mistral_ocr.model' => 'mistral-ocr-2512']);
    config(['services.llm.pricing.mistral-ocr-2512.per_1k_pages' => 20]);
    config(['source_harvest.avg_pages_per_work' => 20]);

    // Pay-as-you-go: eligible × avg_pages/1000 × per_1k × multiplier, > 0.
    $user = $this->loginUser(['status' => 'budget']); // 1.5× multiplier
    $book = $this->makeBook($user);
    harvSeedBibEntry($book, ['canonical_source_id' => harvSeedCanonical()]);

    $resp = $this->postJson("/api/library/{$book}/harvest/estimate")->assertOk();
    expect($resp->json('cost.is_premium'))->toBeFalse();
    // 1 eligible × 20/1000 × 20 × 1.5 = 0.60
    expect($resp->json('cost.estimated_user'))->toBe(0.6);

    // Premium: included (no per-use charge).
    $prem = $this->loginUser(['status' => 'premium']);
    $book2 = $this->makeBook($prem);
    harvSeedBibEntry($book2, ['canonical_source_id' => harvSeedCanonical()]);
    $resp2 = $this->postJson("/api/library/{$book2}/harvest/estimate")->assertOk();
    expect($resp2->json('cost.is_premium'))->toBeTrue();
    expect((float) $resp2->json('cost.estimated_user'))->toBe(0.0);
});

test('trigger stores the optional max_spend cap on the harvest row', function () {
    Queue::fake();
    $user = $this->loginUser(['status' => 'premium']);
    $book = $this->makeBook($user);

    $id = $this->postJson("/api/library/{$book}/harvest/trigger", ['depth' => 1, 'max_spend' => 3.50])
        ->assertOk()->json('harvest_id');
    expect((float) harvDb()->table('source_network_harvests')->where('id', $id)->value('max_spend'))->toBe(3.5);

    // Omitted → null (no cap).
    $book2 = $this->makeBook($user);
    $id2 = $this->postJson("/api/library/{$book2}/harvest/trigger", ['depth' => 1])->assertOk()->json('harvest_id');
    expect(harvDb()->table('source_network_harvests')->where('id', $id2)->value('max_spend'))->toBeNull();
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
    expect((int) $row->max_depth)->toBe(1); // default when no depth given
});

test('the depth choice sets max_depth and scales the work budget', function () {
    Queue::fake();
    $user = $this->loginUser(['status' => 'premium']);

    // Depth 1 → shallow cap.
    $book1 = $this->makeBook($user);
    $id1 = $this->postJson("/api/library/{$book1}/harvest/trigger", ['depth' => 1])->assertOk()->json('harvest_id');
    $r1 = harvDb()->table('source_network_harvests')->where('id', $id1)->first();
    expect((int) $r1->max_depth)->toBe(1);
    expect((int) $r1->max_works)->toBe((int) config('source_harvest.max_works_per_run'));

    // Depth 3 → that depth + the deeper work cap.
    $book3 = $this->makeBook($user);
    $id3 = $this->postJson("/api/library/{$book3}/harvest/trigger", ['depth' => 3])->assertOk()->json('harvest_id');
    $r3 = harvDb()->table('source_network_harvests')->where('id', $id3)->first();
    expect((int) $r3->max_depth)->toBe(3);
    expect((int) $r3->max_works)->toBe((int) config('source_harvest.max_works_deep'));

    // Unlimited → sentinel depth + deep cap.
    $bookU = $this->makeBook($user);
    $idU = $this->postJson("/api/library/{$bookU}/harvest/trigger", ['depth' => 'unlimited'])->assertOk()->json('harvest_id');
    $rU = harvDb()->table('source_network_harvests')->where('id', $idU)->first();
    expect((int) $rU->max_depth)->toBe((int) config('source_harvest.unlimited_depth'));
    expect((int) $rU->max_works)->toBe((int) config('source_harvest.max_works_deep'));
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

test('status exposes the yield report book and the failed count', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book, [
        'status'      => 'completed',
        'report_book' => 'apitest_report_book',
        // attempted 5, 2 imported → 3 couldn't be fetched.
        'counts'      => json_encode(['attempted' => 5, 'assigned' => 1, 'assigned_existing' => 1]),
    ]);

    $this->getJson("/api/source-harvest/status/{$id}")
        ->assertOk()
        ->assertJsonPath('harvest.report_book', 'apitest_report_book')
        ->assertJsonPath('harvest.failed_count', 3);
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

// ── Cancel endpoint ────────────────────────────────────────────────

test('cancel requires authentication', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book, ['user_id' => $user->id]);

    app('auth')->guard('web')->logout();
    $this->post("/api/source-harvest/{$id}/cancel")->assertStatus(401);
});

test('cancel is 403 for a non-owner and 200 (sets cancel_requested) for the owner', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner);
    $id = harvSeedHarvest($book, ['user_id' => $owner->id, 'status' => 'running']);

    // Someone else cannot cancel.
    $this->loginUser();
    $this->postJson("/api/source-harvest/{$id}/cancel")->assertStatus(403);
    expect((bool) harvDb()->table('source_network_harvests')->where('id', $id)->value('cancel_requested'))->toBeFalse();

    // The owner can.
    $this->actingAs($owner);
    $this->postJson("/api/source-harvest/{$id}/cancel")->assertOk();
    expect((bool) harvDb()->table('source_network_harvests')->where('id', $id)->value('cancel_requested'))->toBeTrue();
});

test('cancel is 422 once the harvest has finished', function () {
    $user = $this->loginUser();
    $book = $this->makeBook($user);
    $id = harvSeedHarvest($book, ['user_id' => $user->id, 'status' => 'completed']);

    $this->postJson("/api/source-harvest/{$id}/cancel")->assertStatus(422);
});

test('finish is owner-gated, sets finish_requested, and 422s once finished', function () {
    $owner = $this->loginUser();
    $book = $this->makeBook($owner);
    $id = harvSeedHarvest($book, ['user_id' => $owner->id, 'status' => 'running']);

    // Unauthenticated and non-owner are rejected, flag untouched.
    app('auth')->guard('web')->logout();
    $this->post("/api/source-harvest/{$id}/finish")->assertStatus(401);
    $this->loginUser();
    $this->postJson("/api/source-harvest/{$id}/finish")->assertStatus(403);
    expect((bool) harvDb()->table('source_network_harvests')->where('id', $id)->value('finish_requested'))->toBeFalse();

    // The owner can finish early.
    $this->actingAs($owner);
    $this->postJson("/api/source-harvest/{$id}/finish")->assertOk();
    expect((bool) harvDb()->table('source_network_harvests')->where('id', $id)->value('finish_requested'))->toBeTrue();

    // Once terminal, finish is a 422 like cancel.
    harvDb()->table('source_network_harvests')->where('id', $id)->update(['status' => 'completed']);
    $this->postJson("/api/source-harvest/{$id}/finish")->assertStatus(422);
});

test('cancel is 404 for an unknown harvest', function () {
    $this->loginUser();
    $this->postJson('/api/source-harvest/' . Str::uuid() . '/cancel')->assertStatus(404);
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
