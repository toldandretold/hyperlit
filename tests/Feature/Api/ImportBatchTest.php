<?php

/**
 * Import batches: the API + service behind the import-queue widget.
 *
 * Invariants pinned here:
 *  - POST /api/import-batches creates the batch + items (pending_upload) and,
 *    with auto_shelf, the shelf — all RLS-owned by the caller.
 *  - GET /api/my-imports is RLS-scoped (a stranger sees nothing of yours) and
 *    overlays each queued/processing item with its live progress.json state,
 *    lazily persisting terminal statuses observed in the file (belt-and-braces
 *    for a missed worker hook).
 *  - notify/dismiss/updateItem on someone else's batch → 404 (RLS matches 0 rows).
 *  - updateItem only allows pending_upload → upload_failed.
 *  - POST /import-file with import_batch_id flips the matching item to queued;
 *    a forged batch id is ignored (import proceeds standalone).
 *  - ImportBatches::onJobTerminal (worker context, pgsql_admin): flips the item,
 *    adds completed books to the batch shelf, and sends ONE batch email when the
 *    last item lands (completed_notified_at idempotency).
 *
 * Seeding recipe follows SubBookVisibilityApiTest: admin-connection fixtures are
 * committed outside the test transaction, so cleanup happens in beforeEach (an
 * afterEach admin delete can deadlock against the open RefreshDatabase
 * transaction); default-connection writes are asserted via the default connection.
 */

use App\Models\ImportBatch;
use App\Models\ImportItem;
use App\Services\DocumentImport\ImportBatches;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class);

function importBatchCleanup(): void
{
    $admin = DB::connection('pgsql_admin');
    $batchIds = $admin->table('import_batches')->where('label', 'like', 'batchtest%')->pluck('id');
    if ($batchIds->isNotEmpty()) {
        $admin->table('import_items')->whereIn('batch_id', $batchIds)->delete();
        $admin->table('import_batches')->whereIn('id', $batchIds)->delete();
    }
    $shelfIds = $admin->table('shelves')->where('name', 'like', 'batchtest%')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        $admin->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        $admin->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
    $admin->table('library')->where('book', 'like', 'batchtest\_%')->delete();
    $admin->table('users')->where('email', 'like', 'batch\_%@test.local')->delete();

    foreach (glob(resource_path('markdown/batchtest_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
}

beforeEach(fn () => importBatchCleanup());

afterEach(function () {
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");
    foreach (glob(resource_path('markdown/batchtest_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
});

function batchPayload(int $n = 2, array $overrides = []): array
{
    $items = [];
    for ($i = 0; $i < $n; $i++) {
        $items[] = ['book' => 'batchtest_' . Str::random(10), 'title' => "Doc {$i}", 'filename' => "doc{$i}.pdf"];
    }

    return array_merge([
        'label' => 'batchtest ' . Str::random(6),
        'source' => 'files',
        'auto_shelf' => false,
        'items' => $items,
    ], $overrides);
}

/* ----------------  create  ---------------- */

test('creating a batch with auto_shelf creates batch, items and shelf', function () {
    $user = $this->seedUser(['email' => 'batch_owner@test.local']);
    $this->actingAs($user);

    $payload = batchPayload(3, ['auto_shelf' => true, 'source' => 'folder']);
    $resp = $this->postJson('/api/import-batches', $payload);

    $resp->assertStatus(201)->assertJsonStructure(['id', 'shelf' => ['id', 'name', 'slug']]);

    $batch = ImportBatch::find($resp->json('id'));
    expect($batch)->not->toBeNull()
        ->and($batch->creator)->toBe($user->name)
        ->and($batch->shelf_id)->toBe($resp->json('shelf.id'))
        ->and($batch->items)->toHaveCount(3);
    expect($batch->items->pluck('status')->unique()->all())->toBe(['pending_upload']);

    $shelf = DB::table('shelves')->where('id', $batch->shelf_id)->first();
    expect($shelf->creator)->toBe($user->name)
        ->and($shelf->visibility)->toBe('private');
});

test('creating a batch without auto_shelf creates no shelf', function () {
    $user = $this->seedUser(['email' => 'batch_noshelf@test.local']);
    $this->actingAs($user);

    $resp = $this->postJson('/api/import-batches', batchPayload(2));

    $resp->assertStatus(201);
    expect($resp->json('shelf'))->toBeNull()
        ->and(ImportBatch::find($resp->json('id'))->shelf_id)->toBeNull();
});

test('batch create validates item book ids and caps size', function () {
    $user = $this->seedUser(['email' => 'batch_valid@test.local']);
    $this->actingAs($user);

    $bad = batchPayload(1);
    $bad['items'][0]['book'] = '../evil';
    $this->postJson('/api/import-batches', $bad)->assertStatus(422);

    $this->postJson('/api/import-batches', batchPayload(0))->assertStatus(422);
});

/* ----------------  explicit shelf_id (maintainer shelf-import drop)  ---------------- */

/** Seed a committed shelf on pgsql_admin (visible to the controller's admin-connection lookup). */
function seedAdminShelf(string $creator, string $visibility = 'public'): string
{
    $shelfId = (string) Str::uuid();
    DB::connection('pgsql_admin')->table('shelves')->insert([
        'id' => $shelfId, 'creator' => $creator, 'name' => 'batchtest target ' . Str::random(4),
        'slug' => 'batchtest-target-' . Str::random(4), 'visibility' => $visibility,
        'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
    ]);

    return $shelfId;
}

test('admin can target any existing shelf via shelf_id and no new shelf is created', function () {
    $systemUser = $this->seedUser(['email' => 'batch_sysowner@test.local']);
    $shelfId = seedAdminShelf($systemUser->name);

    $admin = $this->seedUser(['email' => 'batch_admin@test.local', 'is_admin' => true]);
    $this->actingAs($admin);

    $before = DB::connection('pgsql_admin')->table('shelves')->count();
    $resp = $this->postJson('/api/import-batches', batchPayload(2, ['shelf_id' => $shelfId]));

    $resp->assertStatus(201);
    expect($resp->json('shelf.id'))->toBe($shelfId)
        ->and(ImportBatch::find($resp->json('id'))->shelf_id)->toBe($shelfId)
        ->and(DB::connection('pgsql_admin')->table('shelves')->count())->toBe($before);
});

test('a shelf owner can target their own shelf via shelf_id', function () {
    $owner = $this->seedUser(['email' => 'batch_shelfown@test.local']);
    $shelfId = seedAdminShelf($owner->name, 'private');
    $this->actingAs($owner);

    $resp = $this->postJson('/api/import-batches', batchPayload(1, ['shelf_id' => $shelfId]));
    $resp->assertStatus(201);
    expect(ImportBatch::find($resp->json('id'))->shelf_id)->toBe($shelfId);
});

test('a stranger targeting someone else\'s shelf_id gets 404 and no batch is created', function () {
    $victim = $this->seedUser(['email' => 'batch_victim@test.local']);
    $shelfId = seedAdminShelf($victim->name);

    $attacker = $this->seedUser(['email' => 'batch_shelfatk@test.local']);
    $this->actingAs($attacker);

    $payload = batchPayload(1, ['shelf_id' => $shelfId]);
    $this->postJson('/api/import-batches', $payload)->assertStatus(404);
    expect(ImportBatch::where('label', $payload['label'])->exists())->toBeFalse();
});

test('unknown, malformed, or auto_shelf-combined shelf_id is refused', function () {
    $admin = $this->seedUser(['email' => 'batch_admin2@test.local', 'is_admin' => true]);
    $this->actingAs($admin);

    $this->postJson('/api/import-batches', batchPayload(1, ['shelf_id' => (string) Str::uuid()]))
        ->assertStatus(404);
    $this->postJson('/api/import-batches', batchPayload(1, ['shelf_id' => 'not-a-uuid']))
        ->assertStatus(422);

    $shelfId = seedAdminShelf($admin->name);
    $this->postJson('/api/import-batches', batchPayload(1, ['shelf_id' => $shelfId, 'auto_shelf' => true]))
        ->assertStatus(422);
});

/* ----------------  my-imports  ---------------- */

test('my-imports is RLS-scoped to the caller', function () {
    $owner = $this->seedUser(['email' => 'batch_a@test.local']);
    $this->actingAs($owner);
    $created = $this->postJson('/api/import-batches', batchPayload(2))->assertStatus(201);

    $mine = $this->getJson('/api/my-imports');
    $mine->assertStatus(200);
    expect(collect($mine->json('batches'))->pluck('id'))->toContain($created->json('id'));

    $stranger = $this->seedUser(['email' => 'batch_b@test.local']);
    $this->actingAs($stranger);
    $theirs = $this->getJson('/api/my-imports');
    $theirs->assertStatus(200);
    expect(collect($theirs->json('batches'))->pluck('id'))->not->toContain($created->json('id'));
});

test('my-imports overlays live progress.json onto queued items and lazily persists terminal states', function () {
    $user = $this->seedUser(['email' => 'batch_overlay@test.local']);
    $this->actingAs($user);

    $payload = batchPayload(2);
    $bookA = $payload['items'][0]['book'];
    $bookB = $payload['items'][1]['book'];
    $batchId = $this->postJson('/api/import-batches', $payload)->assertStatus(201)->json('id');

    // Simulate both uploads dispatched (the /import-file linking step).
    ImportItem::where('batch_id', $batchId)->update(['status' => 'queued']);

    // Book A is mid-OCR; book B's job finished but the worker hook was missed.
    File::ensureDirectoryExists(resource_path("markdown/{$bookA}"));
    File::put(resource_path("markdown/{$bookA}/progress.json"), json_encode([
        'status' => 'processing', 'percent' => 42, 'stage' => 'ocr',
        'detail' => 'Reading pages with OCR...', 'updated_at' => now()->toIso8601String(),
    ]));
    File::ensureDirectoryExists(resource_path("markdown/{$bookB}"));
    File::put(resource_path("markdown/{$bookB}/progress.json"), json_encode([
        'status' => 'complete', 'percent' => 100, 'stage' => 'complete',
        'detail' => 'Import complete', 'updated_at' => now()->toIso8601String(),
    ]));

    $resp = $this->getJson('/api/my-imports')->assertStatus(200);
    $batch = collect($resp->json('batches'))->firstWhere('id', $batchId);
    $items = collect($batch['items']);

    $rowA = $items->firstWhere('book', $bookA);
    expect($rowA['status'])->toBe('processing')
        ->and($rowA['percent'])->toBe(42)
        ->and($rowA['stage'])->toBe('ocr');

    $rowB = $items->firstWhere('book', $bookB);
    expect($rowB['status'])->toBe('complete');
    // Lazy persistence: the DB row was flipped, not just the response.
    expect(ImportItem::where('batch_id', $batchId)->where('book', $bookB)->value('status'))->toBe('complete');

    expect($batch['counts']['processing'])->toBe(1)
        ->and($batch['counts']['complete'])->toBe(1);
});

test('my-imports reports queue position when nothing of yours is processing', function () {
    $user = $this->seedUser(['email' => 'batch_queuepos@test.local']);
    $this->actingAs($user);

    $payload = batchPayload(1);
    $book = $payload['items'][0]['book'];
    $batchId = $this->postJson('/api/import-batches', $payload)->assertStatus(201)->json('id');
    ImportItem::where('batch_id', $batchId)->update(['status' => 'queued']);

    File::ensureDirectoryExists(resource_path("markdown/{$book}"));
    File::put(resource_path("markdown/{$book}/progress.json"), json_encode([
        'status' => 'queued', 'percent' => 0, 'stage' => 'queued',
        'detail' => 'Waiting to start...', 'updated_at' => now()->toIso8601String(),
    ]));

    // Two strangers' jobs sit ahead of ours on the default queue, ours last.
    // (Clear residue first — committed job rows from earlier runs would inflate the count.)
    DB::table('jobs')->where('queue', 'default')->delete();
    DB::table('jobs')->insert([
        ['queue' => 'default', 'payload' => json_encode(['displayName' => 'X', 'data' => 'other_book_one']), 'attempts' => 0, 'reserved_at' => null, 'available_at' => time(), 'created_at' => time()],
        ['queue' => 'default', 'payload' => json_encode(['displayName' => 'X', 'data' => 'other_book_two']), 'attempts' => 0, 'reserved_at' => null, 'available_at' => time(), 'created_at' => time()],
        ['queue' => 'default', 'payload' => json_encode(['displayName' => 'X', 'data' => $book]), 'attempts' => 0, 'reserved_at' => null, 'available_at' => time(), 'created_at' => time()],
    ]);

    $resp = $this->getJson('/api/my-imports')->assertStatus(200);
    expect($resp->json('queue.jobs_ahead'))->toBe(2)
        ->and($resp->json('queue.waiting_for_turn'))->toBeTrue();
});

/* ----------------  notify / dismiss / updateItem  ---------------- */

test('notify and dismiss are owner-only (404 for strangers) and dismiss hides the batch', function () {
    $owner = $this->seedUser(['email' => 'batch_own2@test.local']);
    $this->actingAs($owner);
    $batchId = $this->postJson('/api/import-batches', batchPayload(1))->assertStatus(201)->json('id');

    $stranger = $this->seedUser(['email' => 'batch_str2@test.local']);
    $this->actingAs($stranger);
    $this->postJson("/api/import-batches/{$batchId}/notify")->assertStatus(404);
    $this->postJson("/api/import-batches/{$batchId}/dismiss")->assertStatus(404);

    $this->actingAs($owner);
    $this->postJson("/api/import-batches/{$batchId}/notify")->assertStatus(200);
    expect(ImportBatch::find($batchId)->notify_email)->toBeTrue();

    $this->postJson("/api/import-batches/{$batchId}/dismiss")->assertStatus(200);
    $resp = $this->getJson('/api/my-imports')->assertStatus(200);
    expect(collect($resp->json('batches'))->pluck('id'))->not->toContain($batchId);
});

test('updateItem only allows pending_upload to upload_failed', function () {
    $user = $this->seedUser(['email' => 'batch_item@test.local']);
    $this->actingAs($user);

    $payload = batchPayload(1);
    $book = $payload['items'][0]['book'];
    $batchId = $this->postJson('/api/import-batches', $payload)->assertStatus(201)->json('id');

    $this->patchJson("/api/import-batches/{$batchId}/items/{$book}", [
        'status' => 'upload_failed', 'error' => 'network died',
    ])->assertStatus(200);
    expect(ImportItem::where('batch_id', $batchId)->where('book', $book)->value('status'))->toBe('upload_failed');

    // No longer pending → repeat is a 404; and only upload_failed is accepted.
    $this->patchJson("/api/import-batches/{$batchId}/items/{$book}", [
        'status' => 'upload_failed',
    ])->assertStatus(404);
    $this->patchJson("/api/import-batches/{$batchId}/items/{$book}", [
        'status' => 'complete',
    ])->assertStatus(422);
});

/* ----------------  /import-file linking  ---------------- */

test('import-file with import_batch_id flips the matching item to queued', function () {
    Queue::fake();
    $user = $this->seedUser(['email' => 'batch_link@test.local']);
    $this->actingAs($user);

    $payload = batchPayload(1);
    $book = $payload['items'][0]['book'];
    $batchId = $this->postJson('/api/import-batches', $payload)->assertStatus(201)->json('id');

    $this->post('/import-file', [
        'book' => $book,
        'title' => 'Linked Doc',
        'import_batch_id' => $batchId,
        'markdown_file' => [UploadedFile::fake()->createWithContent('doc.md', "# Hello\n\nBody.")],
    ], ['Accept' => 'application/json'])->assertStatus(200);

    expect(ImportItem::where('batch_id', $batchId)->where('book', $book)->value('status'))->toBe('queued');
});

test('a forged import_batch_id is ignored and the import still succeeds', function () {
    Queue::fake();
    $owner = $this->seedUser(['email' => 'batch_forge_own@test.local']);
    $this->actingAs($owner);
    $payload = batchPayload(1);
    $foreignBook = $payload['items'][0]['book'];
    $foreignBatch = $this->postJson('/api/import-batches', $payload)->assertStatus(201)->json('id');

    $attacker = $this->seedUser(['email' => 'batch_forge_atk@test.local']);
    $this->actingAs($attacker);
    $this->post('/import-file', [
        'book' => $foreignBook,
        'title' => 'Hijack attempt',
        'import_batch_id' => $foreignBatch,
        'markdown_file' => [UploadedFile::fake()->createWithContent('doc.md', "# Hi\n\nBody.")],
    ], ['Accept' => 'application/json'])->assertStatus(200);

    // RLS: the attacker's request cannot see/update the owner's item. The rows
    // live in the (uncommitted) test transaction, so read them back through the
    // DEFAULT connection under the OWNER's RLS context — pgsql_admin can't see them.
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$owner->name]);
    expect(
        DB::table('import_items')
            ->where('batch_id', $foreignBatch)->where('book', $foreignBook)->value('status')
    )->toBe('pending_upload');
});

/* ----------------  worker terminal hook  ---------------- */

/** Seed a committed (admin-connection) batch so the worker-context service can see it. */
function seedAdminBatch($user, int $items = 2, ?string $shelfId = null, bool $notify = false): array
{
    $admin = DB::connection('pgsql_admin');
    $batchId = (string) Str::uuid();
    $admin->table('import_batches')->insert([
        'id' => $batchId,
        'user_id' => $user->id,
        'creator' => $user->name,
        'label' => 'batchtest worker ' . Str::random(4),
        'source' => 'folder',
        'shelf_id' => $shelfId,
        'notify_email' => $notify,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $books = [];
    for ($i = 0; $i < $items; $i++) {
        $book = 'batchtest_' . Str::random(10);
        $books[] = $book;
        $admin->table('import_items')->insert([
            'id' => (string) Str::uuid(),
            'batch_id' => $batchId,
            'book' => $book,
            'position' => $i,
            'status' => 'processing',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    return [$batchId, $books];
}

test('onJobTerminal flips the item, shelves completed books, and emails once when the batch finishes', function () {
    Mail::fake();
    $admin = DB::connection('pgsql_admin');
    $user = $this->seedUser(['email' => 'batch_worker@test.local']);

    $shelfId = (string) Str::uuid();
    $admin->table('shelves')->insert([
        'id' => $shelfId, 'creator' => $user->name, 'name' => 'batchtest shelf ' . Str::random(4),
        'slug' => 'batchtest-shelf-' . Str::random(4), 'visibility' => 'private',
        'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now(),
    ]);

    [$batchId, $books] = seedAdminBatch($user, 2, $shelfId, notify: true);
    $svc = app(ImportBatches::class);

    $svc->onJobTerminal($books[0], true, null);
    expect($admin->table('import_items')->where('batch_id', $batchId)->where('book', $books[0])->value('status'))->toBe('complete')
        ->and($admin->table('shelf_items')->where('shelf_id', $shelfId)->where('book', $books[0])->exists())->toBeTrue();
    Mail::assertNothingSent(); // one item still live

    $svc->onJobTerminal($books[1], false, 'conversion exploded');
    expect($admin->table('import_items')->where('batch_id', $batchId)->where('book', $books[1])->value('status'))->toBe('failed')
        ->and($admin->table('shelf_items')->where('shelf_id', $shelfId)->where('book', $books[1])->exists())->toBeFalse();
    Mail::assertSent(\App\Mail\ImportBatchCompleteMail::class, 1);

    // Idempotency: a replayed terminal hook can't email twice (item already
    // terminal → early return; completed_notified_at claim guards the rest).
    $svc->onJobTerminal($books[1], false, 'replay');
    Mail::assertSent(\App\Mail\ImportBatchCompleteMail::class, 1);
    expect($admin->table('import_batches')->where('id', $batchId)->value('completed_notified_at'))->not->toBeNull();
});

test('onJobTerminal ignores books that belong to no batch', function () {
    app(ImportBatches::class)->onJobTerminal('batchtest_' . Str::random(10), true, null);
    expect(true)->toBeTrue(); // no exception is the assertion
});
