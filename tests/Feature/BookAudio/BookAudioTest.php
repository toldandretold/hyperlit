<?php

use App\Jobs\GenerateBookAudioJob;
use App\Services\BookAudioStore;
use App\Services\Tts\TtsProviderInterface;
use App\Services\Tts\TtsResult;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/**
 * Per-node TTS audiobook (BookAudioController + GenerateBookAudioJob):
 * RLS-gated serving/manifest, the generate endpoint's gate ladder, and the
 * job's hash-skip idempotency (one charge, resumable, regen = changed nodes
 * only). TTS provider is faked — no network.
 */

function audioBook(): string
{
    return 'audiorls_'.Str::lower(Str::random(10));
}

function seedAudioRow(string $book, string $nodeId, string $plainText, array $extra = []): string
{
    $hash = hash('sha256', $plainText);
    $filename = $nodeId.'-'.substr($hash, 0, 8).'.mp3';
    DB::connection('pgsql_admin')->table('book_audio')->insert(array_merge([
        'id' => (string) Str::uuid(),
        'book' => $book,
        'node_id' => $nodeId,
        'filename' => $filename,
        'source_hash' => $hash,
        'voice' => 'af_heart',
        'chars' => mb_strlen($plainText),
        'duration_ms' => 1000,
        'bytes' => 3,
        'created_at' => now(),
        'updated_at' => now(),
    ], $extra));

    return $filename;
}

function putAudioFile(string $book, string $filename, string $bytes = 'MP3FAKEBYTES-0123456789'): void
{
    $path = app(BookAudioStore::class)->path($book, $filename);
    File::ensureDirectoryExists(dirname($path));
    File::put($path, $bytes);
}

/** Set the RLS session context so billing_ledger reads see the user's rows. */
function actAsBillingUser(\App\Models\User $user): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
}

/** A provider that "synthesizes" deterministic fake MP3 bytes and counts calls. */
function fakeTts(): TtsProviderInterface
{
    return new class implements TtsProviderInterface
    {
        public array $synthesized = [];

        public function synthesize(string $text, string $voice): TtsResult
        {
            $this->synthesized[] = $text;

            return new TtsResult(bytes: 'FAKEMP3:'.substr(hash('sha256', $text), 0, 12));
        }

        public function synthesizeBatch(array $textsByKey, string $voice): array
        {
            $out = [];
            foreach ($textsByKey as $key => $text) {
                $out[$key] = $this->synthesize($text, $voice);
            }

            return $out;
        }

        public function maxCharsPerRequest(): int
        {
            return 1500;
        }
    };
}

// ---------------------------------------------------------------------------
// Serving route (/{book}/audio/{filename}) — RLS is the authorization
// ---------------------------------------------------------------------------

it('serves a PUBLIC book audio file to anyone, cacheable, and honours Range', function () {
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $filename = seedAudioRow($book, $book.'_n1', 'Hello world.');
    putAudioFile($book, $filename);

    $resp = $this->get("/{$book}/audio/{$filename}")
        ->assertOk()
        ->assertHeader('Content-Type', 'audio/mpeg');
    $cache = $resp->headers->get('Cache-Control');
    expect($cache)->toContain('max-age=3600')->toContain('public')->not->toContain('no-store');

    // Range → 206 partial content (what <audio> seeking relies on)
    $this->get("/{$book}/audio/{$filename}", ['Range' => 'bytes=0-9'])
        ->assertStatus(206)
        ->assertHeader('Content-Range', 'bytes 0-9/23');
});

it('serves a PRIVATE book audio to its owner (no-store) but 404s strangers and anonymous', function () {
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    $filename = seedAudioRow($book, $book.'_n1', 'Secret text.');
    putAudioFile($book, $filename);

    $resp = $this->actingAs($owner)->get("/{$book}/audio/{$filename}")->assertOk();
    expect($resp->headers->get('Cache-Control'))->toContain('no-store')->not->toContain('public');

    $stranger = $this->seedUser();
    $this->actingAs($stranger)->get("/{$book}/audio/{$filename}")->assertNotFound();
    $this->get("/{$book}/audio/{$filename}")->assertNotFound(); // fully anonymous
});

it('404s when the row is absent even if a file exists (row is the source of truth)', function () {
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    putAudioFile($book, 'ghost-12345678.mp3'); // file but NO row

    $this->get("/{$book}/audio/ghost-12345678.mp3")->assertNotFound();
});

// ---------------------------------------------------------------------------
// Generate endpoint — the gate ladder
// ---------------------------------------------------------------------------

it('requires auth to generate (401)', function () {
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);

    $this->postJson("/api/book-audio/{$book}/generate")->assertStatus(401);
});

it('refuses encrypted books (403) — no plaintext exists server-side', function () {
    $book = audioBook();
    $owner = $this->seedUser(['credits' => 10]);
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'private', 'encrypted' => true,
    ]);

    $this->actingAs($owner)->postJson("/api/book-audio/{$book}/generate")->assertStatus(403);
});

it('refuses when balance is empty (402)', function () {
    $book = audioBook();
    $owner = $this->seedUser(['credits' => 0, 'debits' => 0]);
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);

    $this->actingAs($owner)->postJson("/api/book-audio/{$book}/generate")->assertStatus(402);
});

it('dispatches the job on success (202) and 409s a concurrent second press', function () {
    Queue::fake();
    $book = audioBook();
    $owner = $this->seedUser(['credits' => 10]);
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);

    $this->actingAs($owner)->postJson("/api/book-audio/{$book}/generate")->assertStatus(202);
    Queue::assertPushed(GenerateBookAudioJob::class, 1);

    // The lock is held until the (faked, never-run) job releases it → 409.
    $this->actingAs($owner)->postJson("/api/book-audio/{$book}/generate")->assertStatus(409);
    Queue::assertPushed(GenerateBookAudioJob::class, 1);

    Cache::lock("book-audio:{$book}")->forceRelease();
});

it('404s generation of a book the caller cannot see (no existence leak)', function () {
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);

    $stranger = $this->seedUser(['credits' => 10]);
    $this->actingAs($stranger)->postJson("/api/book-audio/{$book}/generate")->assertStatus(404);
});

// ---------------------------------------------------------------------------
// Manifest — computed staleness
// ---------------------------------------------------------------------------

it('marks a node stale in the manifest once its plainText changes', function () {
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1', 'content' => '<p>Original text.</p>', 'plainText' => 'Original text.', 'type' => 'text']);
    $this->seedNode(['book' => $book, 'startLine' => 2, 'node_id' => $book.'_n2', 'content' => '<p>Untouched.</p>', 'plainText' => 'Untouched.', 'type' => 'text']);
    seedAudioRow($book, $book.'_n1', 'Original text.');
    seedAudioRow($book, $book.'_n2', 'Untouched.');

    $fresh = $this->getJson("/api/book-audio/{$book}/manifest")->assertOk()->json();
    expect($fresh['nodes'][$book.'_n1']['stale'])->toBeFalse();
    expect($fresh['nodes'][$book.'_n2']['stale'])->toBeFalse();

    // Edit n1's text (admin write, as the sync path would)
    DB::connection('pgsql_admin')->table('nodes')
        ->where('book', $book)->where('node_id', $book.'_n1')
        ->update(['plainText' => 'Edited text.', 'content' => '<p>Edited text.</p>']);

    $after = $this->getJson("/api/book-audio/{$book}/manifest")->assertOk()->json();
    expect($after['nodes'][$book.'_n1']['stale'])->toBeTrue();
    expect($after['nodes'][$book.'_n2']['stale'])->toBeFalse();
});

it('hides the manifest of an invisible book (404)', function () {
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);

    $this->getJson("/api/book-audio/{$book}/manifest")->assertNotFound();
});

// ---------------------------------------------------------------------------
// Job — hash-skip idempotency + single post-success charge
// ---------------------------------------------------------------------------

it('generates per-node audio, charges once for synthesized chars, and re-running is a no-op', function () {
    $book = audioBook();
    $owner = $this->seedUser(['credits' => 10]);
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1', 'content' => '<p>First paragraph.</p>', 'plainText' => 'First paragraph.', 'type' => 'text']);
    $this->seedNode(['book' => $book, 'startLine' => 2, 'node_id' => $book.'_n2', 'content' => '<p>Second paragraph.</p>', 'plainText' => 'Second paragraph.', 'type' => 'text']);
    $this->seedNode(['book' => $book, 'startLine' => 3, 'node_id' => $book.'_n3', 'content' => '<p></p>', 'plainText' => '   ', 'type' => 'text']); // whitespace → skipped

    $tts = fakeTts();
    $store = app(BookAudioStore::class);

    (new GenerateBookAudioJob($book, $owner->id, 'af_heart'))->handle($store, $tts);

    // Two speakable nodes synthesized; whitespace node skipped.
    expect($tts->synthesized)->toHaveCount(2);
    $rows = DB::connection('pgsql_admin')->table('book_audio')->where('book', $book)->get();
    expect($rows)->toHaveCount(2);
    foreach ($rows as $row) {
        expect(is_file($store->path($book, $row->filename)))->toBeTrue();
    }

    // Exactly one 'tts' debit, for the synthesized chars at the configured
    // rate. Read on the DEFAULT connection (the charge ran inside the test's
    // uncommitted RefreshDatabase transaction — invisible to pgsql_admin),
    // with the RLS context set so the row is visible.
    actAsBillingUser($owner);
    $ledger = DB::table('billing_ledger')
        ->where('user_id', $owner->id)->where('category', 'tts')->get();
    expect($ledger)->toHaveCount(1);
    $chars = mb_strlen('First paragraph.') + mb_strlen('Second paragraph.');
    $rate = (float) config('services.tts.pricing.billed_per_million_chars');
    expect((float) $ledger[0]->amount)->toEqualWithDelta($chars / 1_000_000 * $rate * $owner->getBillingMultiplier(), 0.0001);

    // Progress file reports done.
    $progress = json_decode(File::get($store->progressPath($book)), true);
    expect($progress['status'])->toBe('done');
    expect($progress['done_nodes'])->toBe(2);

    // Second run: everything hash-matches → zero synthesis, zero new charges.
    (new GenerateBookAudioJob($book, $owner->id, 'af_heart'))->handle($store, $tts);
    expect($tts->synthesized)->toHaveCount(2);
    actAsBillingUser($owner);
    expect(DB::table('billing_ledger')
        ->where('user_id', $owner->id)->where('category', 'tts')->count())->toBe(1);

    // Cleanup files (rows are cleaned by the trait).
    $store->purgeBook($book);
});

it('regenerates ONLY the edited node and bills only the gap', function () {
    $book = audioBook();
    $owner = $this->seedUser(['credits' => 10]);
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1', 'content' => '<p>Alpha.</p>', 'plainText' => 'Alpha.', 'type' => 'text']);
    $this->seedNode(['book' => $book, 'startLine' => 2, 'node_id' => $book.'_n2', 'content' => '<p>Beta.</p>', 'plainText' => 'Beta.', 'type' => 'text']);

    $tts = fakeTts();
    $store = app(BookAudioStore::class);
    (new GenerateBookAudioJob($book, $owner->id, 'af_heart'))->handle($store, $tts);
    expect($tts->synthesized)->toHaveCount(2);
    $n1FileBefore = DB::connection('pgsql_admin')->table('book_audio')
        ->where('book', $book)->where('node_id', $book.'_n1')->value('filename');

    // Edit n1 only (content is the narration source; plainText is ignored).
    DB::connection('pgsql_admin')->table('nodes')
        ->where('book', $book)->where('node_id', $book.'_n1')
        ->update(['content' => '<p>Alpha, edited.</p>', 'plainText' => 'Alpha, edited.']);

    (new GenerateBookAudioJob($book, $owner->id, 'af_heart'))->handle($store, $tts);

    // One more synthesis (n1 only), n2 untouched.
    expect($tts->synthesized)->toHaveCount(3);
    expect(end($tts->synthesized))->toBe('Alpha, edited.');

    $n1FileAfter = DB::connection('pgsql_admin')->table('book_audio')
        ->where('book', $book)->where('node_id', $book.'_n1')->value('filename');
    expect($n1FileAfter)->not->toBe($n1FileBefore);
    expect(is_file($store->path($book, $n1FileAfter)))->toBeTrue();
    expect(is_file($store->path($book, $n1FileBefore)))->toBeFalse(); // superseded file deleted

    // Second charge covers only the edited node's chars (default connection —
    // see the idempotency test's ledger-read note).
    actAsBillingUser($owner);
    $ledger = DB::table('billing_ledger')
        ->where('user_id', $owner->id)->where('category', 'tts')->orderBy('created_at')->get();
    expect($ledger)->toHaveCount(2);

    $store->purgeBook($book);
});

it('narrates nodes whose plainText was never populated (content is the only source)', function () {
    // Regression: a 280-node prod book had plainText on only 3 rows (write-path
    // dependent) — the job narrated 3 paragraphs and playback "jumped around".
    // SpeakableText now ALWAYS derives from content.
    $book = audioBook();
    $owner = $this->seedUser(['credits' => 10]);
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1', 'content' => '<p>Has plain.</p>', 'plainText' => 'Has plain.', 'type' => 'text']);
    $this->seedNode(['book' => $book, 'startLine' => 2, 'node_id' => $book.'_n2', 'content' => '<p>Only <em>content</em> here.</p>', 'plainText' => null, 'type' => 'text']);

    $tts = fakeTts();
    $store = app(BookAudioStore::class);
    (new GenerateBookAudioJob($book, $owner->id, 'af_heart'))->handle($store, $tts);

    // Both nodes narrated; the fallback spoke the tag-stripped content.
    expect($tts->synthesized)->toHaveCount(2);
    expect($tts->synthesized[1])->toBe('Only content here.');

    // And the manifest agrees it's fresh (hash derivation matches the job's).
    $manifest = $this->getJson("/api/book-audio/{$book}/manifest")->assertOk()->json();
    expect($manifest['nodes'][$book.'_n2']['stale'])->toBeFalse();

    $store->purgeBook($book);
});

// ---------------------------------------------------------------------------
// E2EE — audio SURVIVES the lock (encrypted in place, the book_images pattern)
// ---------------------------------------------------------------------------

/** Raw-body PUT (the octet-stream byte-replace endpoint). */
function rawAudioPut($test, string $url, string $body)
{
    return $test->call('PUT', $url, [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $body);
}

it('audio blob PUT: owner-only, row must exist', function () {
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $filename = seedAudioRow($book, $book.'_n1', 'Hello.');
    putAudioFile($book, $filename);

    // Guest → 401
    rawAudioPut($this, "/api/books/{$book}/audio/{$filename}", 'x')->assertStatus(401);

    // Stranger who CAN see the (public) book but isn't owner → 403
    $stranger = $this->seedUser();
    $this->actingAs($stranger);
    rawAudioPut($this, "/api/books/{$book}/audio/{$filename}", 'x')->assertStatus(403);

    // Owner, missing row → 404
    $this->actingAs($owner);
    rawAudioPut($this, "/api/books/{$book}/audio/ghost-12345678.mp3", 'x')->assertStatus(404);

    app(BookAudioStore::class)->purgeBook($book);
});

it('the encrypt transition keeps audio rows and files (no purge — the client encrypts them in place)', function () {
    \App\Services\E2ee\EncryptedBookGuard::forget();
    $book = audioBook();
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    $filename = seedAudioRow($book, $book.'_n1', 'Spoken words.');
    putAudioFile($book, $filename);

    $this->actingAs($owner)
        ->postJson("/api/db/library/{$book}/encryption", ['encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B'])
        ->assertOk()->assertJsonPath('encrypted', true);

    $store = app(BookAudioStore::class);
    expect(DB::connection('pgsql_admin')->table('book_audio')->where('book', $book)->count())->toBe(1)
        ->and(is_file($store->path($book, $filename)))->toBeTrue();

    $store->purgeBook($book);
});

it('audio blob PUT: the HLENC1 magic guard enforces the book\'s encryption direction', function () {
    // The guard reads the encrypted flag on the ADMIN connection (identical for
    // HTTP and workers), so the flag must be SEEDED (committed), not transitioned
    // inside this test's uncommitted transaction — same pattern as the 403 test.
    \App\Services\E2ee\EncryptedBookGuard::forget();
    $owner = $this->seedUser();

    // Direction 1: a plaintext book refuses a ciphertext blob.
    $plainBook = audioBook();
    $this->seedLibrary(['book' => $plainBook, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $plainFile = seedAudioRow($plainBook, $plainBook.'_n1', 'Plain words.');
    putAudioFile($plainBook, $plainFile);
    $this->actingAs($owner);
    rawAudioPut($this, "/api/books/{$plainBook}/audio/{$plainFile}", 'HLENC1'.str_repeat("\x00", 40))
        ->assertStatus(422);

    // Direction 2: an encrypted book refuses plaintext bytes...
    $encBook = audioBook();
    $this->seedLibrary([
        'book' => $encBook, 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'private', 'encrypted' => true, 'wrapped_dek' => 'hlenc.v1.A.B',
    ]);
    $encFile = seedAudioRow($encBook, $encBook.'_n1', 'Secret words.');
    putAudioFile($encBook, $encFile);
    rawAudioPut($this, "/api/books/{$encBook}/audio/{$encFile}", 'plain mp3 bytes')->assertStatus(422);

    // ...and accepts the HLENC1 blob, flipping the row's encrypted flag.
    rawAudioPut($this, "/api/books/{$encBook}/audio/{$encFile}", 'HLENC1'.str_repeat("\x01", 40))
        ->assertOk()->assertJson(['encrypted' => true]);
    expect((bool) DB::connection('pgsql_admin')->table('book_audio')
        ->where('book', $encBook)->where('filename', $encFile)->value('encrypted'))->toBeTrue();

    // The list endpoint reports the flag (what the lock/publish passes filter on).
    $files = $this->getJson("/api/books/{$encBook}/audio")->assertOk()->json('files');
    expect($files)->toHaveCount(1)->and((bool) $files[0]['encrypted'])->toBeTrue();

    // Serving an encrypted row: octet-stream, not audio/mpeg.
    $resp = $this->get("/{$encBook}/audio/{$encFile}")->assertOk();
    expect($resp->headers->get('Content-Type'))->toContain('application/octet-stream');

    // Manifest for an encrypted book: staleness is unknowable (content is
    // ciphertext) → reported fresh, with the per-row encrypted flag exposed.
    $manifest = $this->getJson("/api/book-audio/{$encBook}/manifest")->assertOk()->json();
    expect($manifest['nodes'][$encBook.'_n1']['stale'])->toBeFalse()
        ->and((bool) $manifest['nodes'][$encBook.'_n1']['encrypted'])->toBeTrue();

    app(BookAudioStore::class)->purgeBook($plainBook);
    app(BookAudioStore::class)->purgeBook($encBook);
});

it('prunes audio rows for nodes that no longer exist', function () {
    $book = audioBook();
    $owner = $this->seedUser(['credits' => 10]);
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1', 'content' => '<p>Kept.</p>', 'plainText' => 'Kept.', 'type' => 'text']);
    // Audio row for a node that does NOT exist in nodes:
    $ghostFile = seedAudioRow($book, $book.'_ghost', 'Deleted paragraph.');
    putAudioFile($book, $ghostFile);

    $store = app(BookAudioStore::class);
    (new GenerateBookAudioJob($book, $owner->id, 'af_heart'))->handle($store, fakeTts());

    $nodeIds = DB::connection('pgsql_admin')->table('book_audio')->where('book', $book)->pluck('node_id')->all();
    expect($nodeIds)->toBe([$book.'_n1']);
    expect(is_file($store->path($book, $ghostFile)))->toBeFalse();

    $store->purgeBook($book);
});
