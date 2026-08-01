<?php

use App\Jobs\BuildAudiobookJob;
use App\Services\Audiobook\AudiobookBuilder;
use App\Services\Audiobook\AudiobookUnavailable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;

/**
 * Whole-book audiobook download: the .m4b packaging endpoints
 * (BookAudioController::audiobookStatus/buildAudiobook/downloadAudiobook) and
 * the pure parts of AudiobookBuilder — ordering, chapter derivation from
 * headings, and the digest that doubles as cache invalidation.
 *
 * The ffmpeg encode itself is NOT exercised here (it needs the binary and takes
 * ~40s on a real book); it is covered by the manual build path. What these lock
 * is the logic that decides WHAT gets packaged and WHO may have it.
 */

/** Segment shape as AudiobookBuilder::segments() returns it. */
function seg(string $nodeId, string $filename, ?string $heading = null): array
{
    return ['node_id' => $nodeId, 'filename' => $filename, 'path' => "/tmp/{$filename}", 'heading' => $heading];
}

// Local copies of BookAudioTest's seeding helpers under distinct names — Pest
// loads every test file into one process, so the names cannot collide.
function abBook(): string
{
    return 'audiorls_'.\Illuminate\Support\Str::lower(\Illuminate\Support\Str::random(10));
}

function abSeedAudioRow(string $book, string $nodeId, string $plainText, array $extra = []): string
{
    $hash = hash('sha256', $plainText);
    $filename = $nodeId.'-'.substr($hash, 0, 8).'.mp3';
    \Illuminate\Support\Facades\DB::connection('pgsql_admin')->table('book_audio')->insert(array_merge([
        'id' => (string) \Illuminate\Support\Str::uuid(),
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

function abPutAudioFile(string $book, string $filename, string $bytes = 'MP3FAKEBYTES-0123456789'): void
{
    $path = app(\App\Services\BookAudioStore::class)->path($book, $filename);
    \Illuminate\Support\Facades\File::ensureDirectoryExists(dirname($path));
    \Illuminate\Support\Facades\File::put($path, $bytes);
}

// ---------------------------------------------------------------------------
// Chapter derivation
// ---------------------------------------------------------------------------

it('opens a chapter at every heading and wraps the run before the first one', function () {
    $builder = app(AudiobookBuilder::class);
    $segments = [
        seg('n0', 'a.mp3'),                    // front matter, no heading
        seg('n1', 'b.mp3', 'Chapter One'),
        seg('n2', 'c.mp3'),
        seg('n3', 'd.mp3', 'Chapter Two'),
    ];

    $chapters = $builder->chapters($segments, [1000, 2000, 3000, 4000], 'The Book');

    expect($chapters)->toHaveCount(3);
    // Everything before the first heading still belongs to a chapter, named for
    // the book — a player must never be positioned outside one.
    expect($chapters[0])->toMatchArray(['start' => 0, 'end' => 1000, 'title' => 'The Book']);
    expect($chapters[1])->toMatchArray(['start' => 1000, 'end' => 6000, 'title' => 'Chapter One']);
    expect($chapters[2])->toMatchArray(['start' => 6000, 'end' => 10000, 'title' => 'Chapter Two']);
});

it('gives a book with no headings a single chapter spanning the whole thing', function () {
    $chapters = app(AudiobookBuilder::class)
        ->chapters([seg('n0', 'a.mp3'), seg('n1', 'b.mp3')], [1500, 2500], 'Untitled');

    expect($chapters)->toHaveCount(1);
    expect($chapters[0])->toMatchArray(['start' => 0, 'end' => 4000, 'title' => 'Untitled']);
});

it('drops zero-length chapters so back-to-back headings do not confuse players', function () {
    $chapters = app(AudiobookBuilder::class)->chapters(
        [seg('n0', 'a.mp3', 'Empty Heading'), seg('n1', 'b.mp3', 'Real Chapter')],
        [0, 5000],
        'Book',
    );

    expect($chapters)->toHaveCount(1);
    expect($chapters[0]['title'])->toBe('Real Chapter');
});

// ---------------------------------------------------------------------------
// Ordering + heading detection off real node rows
// ---------------------------------------------------------------------------

it('orders segments by startLine and reads chapter titles out of the heading HTML', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);

    // Deliberately inserted out of order, and with type NULL — that column is
    // unreliably populated, so heading detection must not depend on it.
    $this->seedNode(['book' => $book, 'startLine' => 3, 'node_id' => $book.'_c', 'content' => '<p>Body of two.</p>', 'plainText' => 'Body of two.']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_a', 'content' => '<h1 id="100">The Only Chapter</h1>', 'plainText' => 'The Only Chapter']);
    $this->seedNode(['book' => $book, 'startLine' => 2, 'node_id' => $book.'_b', 'content' => '<h2>Sub &amp; Section</h2>', 'plainText' => 'Sub & Section']);

    foreach (['a', 'b', 'c'] as $suffix) {
        $filename = abSeedAudioRow($book, $book.'_'.$suffix, 'text '.$suffix);
        abPutAudioFile($book, $filename);
    }

    $segments = app(AudiobookBuilder::class)->segments($book);

    expect(array_column($segments, 'node_id'))->toBe([$book.'_a', $book.'_b', $book.'_c']);
    expect(array_column($segments, 'heading'))->toBe(['The Only Chapter', 'Sub & Section', null]);
});

it('ignores h3 and below, so a book is not shredded into hundreds of chapters', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_a', 'content' => '<h3>Minor Aside</h3>', 'plainText' => 'Minor Aside']);
    abPutAudioFile($book, abSeedAudioRow($book, $book.'_a', 'text a'));

    expect(app(AudiobookBuilder::class)->segments($book)[0]['heading'])->toBeNull();
});

it('refuses to assemble an encrypted book — those bytes are ciphertext, not mp3', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_a', 'content' => '<p>Hi.</p>', 'plainText' => 'Hi.']);
    abPutAudioFile($book, abSeedAudioRow($book, $book.'_a', 'Hi.', ['encrypted' => true]));

    expect(fn () => app(AudiobookBuilder::class)->segments($book))
        ->toThrow(AudiobookUnavailable::class);
});

// ---------------------------------------------------------------------------
// The digest IS the cache invalidation
// ---------------------------------------------------------------------------

it('changes the digest when any node is re-narrated, so a stale audiobook can never be served', function () {
    $builder = app(AudiobookBuilder::class);
    $before = [seg('n0', 'n0-aaaaaaaa.mp3'), seg('n1', 'n1-bbbbbbbb.mp3')];
    // Regeneration renames the file to {node_id}-{newhash8}.mp3.
    $after = [seg('n0', 'n0-aaaaaaaa.mp3'), seg('n1', 'n1-cccccccc.mp3')];

    expect($builder->digestFor($before))->not->toBe($builder->digestFor($after));
    expect($builder->digestFor($before))->toBe($builder->digestFor($before));
});

it('changes the digest when the encode bitrate changes', function () {
    // Otherwise lowering the bitrate silently keeps serving files built at the
    // old one — the source filenames haven't changed, so nothing else would
    // invalidate them.
    $segments = [seg('n0', 'a.mp3'), seg('n1', 'b.mp3')];

    config(['services.audiobook.bitrate' => '32k']);
    $at32 = app(AudiobookBuilder::class)->digestFor($segments);

    config(['services.audiobook.bitrate' => '48k']);
    $at48 = app(AudiobookBuilder::class)->digestFor($segments);

    expect($at32)->not->toBe($at48);
});

it('changes the digest when nodes are reordered or removed', function () {
    $builder = app(AudiobookBuilder::class);
    $base = [seg('n0', 'a.mp3'), seg('n1', 'b.mp3'), seg('n2', 'c.mp3')];

    expect($builder->digestFor($base))->not->toBe($builder->digestFor([$base[1], $base[0], $base[2]]));
    expect($builder->digestFor($base))->not->toBe($builder->digestFor([$base[0], $base[1]]));
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

it('reports an encrypted book as unsupported rather than offering a button that can only fail', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'public', 'encrypted' => true,
    ]);
    \App\Services\E2ee\EncryptedBookGuard::forget($book); // the guard memoizes per process

    $this->getJson("/api/book-audio/{$book}/audiobook")
        ->assertOk()
        ->assertJson(['supported' => false, 'reason' => 'encrypted', 'state' => 'unavailable']);
});

it('404s the status of a book RLS will not show you', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);

    $this->getJson("/api/book-audio/{$book}/audiobook")->assertNotFound();
});

it('refuses to package a book with no narration', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);

    $this->postJson("/api/book-audio/{$book}/audiobook")
        ->assertStatus(422)
        ->assertJson(['success' => false]);
});

it('never packages a sub-book', function () {
    // The route constraint rejects the slash first (404); the controller's own
    // check is defence in depth, and it deliberately runs BEFORE cleanBookId(),
    // which strips '/' and would silently rewrite book_1/Fn2 into book_1Fn2.
    $this->postJson('/api/book-audio/'.urlencode('book_1/Fn2').'/audiobook')
        ->assertNotFound();
});

it('dispatches a build and reports building, and a second press joins it instead of duplicating the encode', function () {
    Queue::fake();
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_a', 'content' => '<p>Hi.</p>', 'plainText' => 'Hi.']);
    abPutAudioFile($book, abSeedAudioRow($book, $book.'_a', 'Hi.'));

    $this->postJson("/api/book-audio/{$book}/audiobook")
        ->assertStatus(202)
        ->assertJson(['success' => true, 'state' => 'building']);
    Queue::assertPushed(BuildAudiobookJob::class, 1);

    // The lock is still held, so a second requester rides the same build.
    $this->postJson("/api/book-audio/{$book}/audiobook")
        ->assertOk()
        ->assertJson(['state' => 'building']);
    Queue::assertPushed(BuildAudiobookJob::class, 1);

    Cache::lock(BuildAudiobookJob::lockKey($book))->forceRelease();
})->skip(fn () => ! app(AudiobookBuilder::class)->isAvailable(), 'ffmpeg not installed on this host');

it('reports building while the lock is held, before the worker has written any progress', function () {
    // The gap between dispatch and the worker's first progress write used to
    // read as idle, and the download button gave up on the build it asked for.
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_a', 'content' => '<p>Hi.</p>', 'plainText' => 'Hi.']);
    abPutAudioFile($book, abSeedAudioRow($book, $book.'_a', 'Hi.'));

    Cache::lock(BuildAudiobookJob::lockKey($book), 60)->get();

    $this->getJson("/api/book-audio/{$book}/audiobook")
        ->assertOk()
        ->assertJson(['state' => 'building']);

    Cache::lock(BuildAudiobookJob::lockKey($book))->forceRelease();
})->skip(fn () => ! app(AudiobookBuilder::class)->isAvailable(), 'ffmpeg not installed on this host');

it('404s a download when nothing has been packaged yet', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'public']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_a', 'content' => '<p>Hi.</p>', 'plainText' => 'Hi.']);
    abPutAudioFile($book, abSeedAudioRow($book, $book.'_a', 'Hi.'));

    $this->get("/{$book}/audiobook.m4b")->assertNotFound();
});

it('streams a packaged audiobook as an attachment named after the book', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token,
        'visibility' => 'public', 'title' => 'A Grand Title', 'author' => 'Some Author',
    ]);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_a', 'content' => '<p>Hi.</p>', 'plainText' => 'Hi.']);
    abPutAudioFile($book, abSeedAudioRow($book, $book.'_a', 'Hi.'));

    // Stand in for a real encode: the route only cares that the cached artifact
    // for the CURRENT digest exists.
    $builder = app(AudiobookBuilder::class);
    $path = $builder->cachedPath($book, $builder->digestFor($builder->segments($book)));
    file_put_contents($path, 'M4BFAKE');

    $response = $this->get("/{$book}/audiobook.m4b");
    $response->assertOk();
    expect($response->headers->get('content-disposition'))
        ->toContain('attachment')
        ->toContain('Some Author - A Grand Title.m4b');
});

it('does not serve a packaged audiobook of a book RLS hides', function () {
    $owner = $this->seedUser();
    $book = abBook();
    $this->seedLibrary(['book' => $book, 'creator' => $owner->name, 'creator_token' => $owner->user_token, 'visibility' => 'private']);
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_a', 'content' => '<p>Hi.</p>', 'plainText' => 'Hi.']);
    abPutAudioFile($book, abSeedAudioRow($book, $book.'_a', 'Hi.'));

    $builder = app(AudiobookBuilder::class);
    file_put_contents($builder->cachedPath($book, $builder->digestFor($builder->segments($book))), 'M4BFAKE');

    $this->get("/{$book}/audiobook.m4b")->assertNotFound();
});
