<?php

use App\Jobs\GenerateBookAudioJob;
use App\Models\User;
use App\Services\BillingService;
use App\Services\BookAudioStore;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * The "clicked Listen and it sat on Generating forever" bug.
 *
 * A job killed without its finally/failed() handlers (a deploy overrunning
 * stopwaitsecs, the OOM killer, a reboot) used to leave three corpses behind:
 *   1. `audio_progress.json` saying `generating`, which nothing ever cleared;
 *   2. the `book-audio:{book}` lock, held for its full 3600s TTL;
 *   3. the credit reservation — a REAL debit on users.debits.
 * Because the client skips dispatching when status says generating, every
 * later press of Listen silently watched a run that no longer existed, for up
 * to an hour, while the user stayed debited for audio they never received.
 *
 * These lock the recovery: a cold heartbeat means dead, and dead means
 * resumable + refunded.
 */

function stalledBook(): string
{
    return 'audiostall_'.Str::lower(Str::random(10));
}

/** Write a progress record with a heartbeat `$age` seconds in the past. */
function writeProgressFile(string $book, array $overrides = [], ?int $ageSeconds = null): void
{
    $path = app(BookAudioStore::class)->progressPath($book);
    File::ensureDirectoryExists(dirname($path), 0755);
    File::put($path, json_encode(array_merge([
        'status' => 'generating',
        'stage' => 'narrating',
        'done_nodes' => 4,
        'total_nodes' => 100,
        'done_chars' => 400,
        'total_chars' => 10000,
        'failed_nodes' => [],
        'updated_at' => now()->subSeconds($ageSeconds ?? 0)->toIso8601String(),
    ], $overrides)));
}

/** The RLS session vars billing reads (mirrors BookAudioTest's actAsBillingUser). */
function actAsStallBillingUser(User $user): void
{
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name]);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [(string) $user->user_token]);
}

// ---------------------------------------------------------------------------
// progress(): a cold run is reported as dead, not as still running
// ---------------------------------------------------------------------------

it('keeps reporting a run that is still heartbeating', function () {
    $owner = $this->seedUser();
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Some narratable text.</p>', 'plainText' => 'Some narratable text.',
    ]);
    writeProgressFile($book, [], 10); // 10s ago — alive

    $this->getJson("/api/book-audio/{$book}/progress")
        ->assertOk()
        ->assertJson(['status' => 'generating']);
});

it('reports a run whose heartbeat went cold as failed, with a resumable message', function () {
    $owner = $this->seedUser();
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Some narratable text.</p>', 'plainText' => 'Some narratable text.',
    ]);
    writeProgressFile($book, [], 600); // 10 minutes of silence

    $response = $this->getJson("/api/book-audio/{$book}/progress")->assertOk();

    $response->assertJson(['status' => 'failed', 'stalled' => true]);
    // The player prints this verbatim, so it has to tell the user what to do.
    expect($response->json('error'))->toContain('Press Listen');
    // ...and what it managed before dying, so the message isn't a shrug.
    $response->assertJson(['done_nodes' => 4, 'total_nodes' => 100]);
});

it('treats a generating record with no timestamp at all as dead', function () {
    $owner = $this->seedUser();
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Some narratable text.</p>', 'plainText' => 'Some narratable text.',
    ]);
    writeProgressFile($book, ['updated_at' => null]);

    $this->getJson("/api/book-audio/{$book}/progress")
        ->assertOk()
        ->assertJson(['status' => 'failed', 'stalled' => true]);
});

it('leaves an already-terminal record alone however old it is', function () {
    $owner = $this->seedUser();
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Some narratable text.</p>', 'plainText' => 'Some narratable text.',
    ]);
    writeProgressFile($book, ['status' => 'done'], 99999);

    $this->getJson("/api/book-audio/{$book}/progress")
        ->assertOk()
        ->assertJson(['status' => 'done']);
});

// ---------------------------------------------------------------------------
// status(): `generating` must mean alive, not merely locked
// ---------------------------------------------------------------------------

it('does not call a book generating when the lock is held by a corpse', function () {
    // THE bug: the client skips dispatching whenever this says true, so a
    // stale lock made every press of Listen a silent no-op for an hour.
    $owner = $this->seedUser();
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Some narratable text.</p>', 'plainText' => 'Some narratable text.',
    ]);

    Cache::lock("book-audio:{$book}", 3600)->get();
    writeProgressFile($book, [], 600);

    $this->getJson("/api/book-audio/{$book}/status")
        ->assertOk()
        ->assertJson(['generating' => false]);

    Cache::lock("book-audio:{$book}")->forceRelease();
});

it('still calls a book generating while the run is warm', function () {
    $owner = $this->seedUser();
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Some narratable text.</p>', 'plainText' => 'Some narratable text.',
    ]);

    Cache::lock("book-audio:{$book}", 3600)->get();
    writeProgressFile($book, [], 5);

    $this->getJson("/api/book-audio/{$book}/status")
        ->assertOk()
        ->assertJson(['generating' => true]);

    Cache::lock("book-audio:{$book}")->forceRelease();
});

// ---------------------------------------------------------------------------
// generate(): a dead lock must not make a book un-narratable
// ---------------------------------------------------------------------------

it('takes over a stale lock instead of 409ing against a run that no longer exists', function () {
    $owner = $this->seedUser(['credits' => 10, 'debits' => 0, 'status' => 'budget']);
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Some narratable text.</p>', 'plainText' => 'Some narratable text.',
    ]);

    Cache::lock("book-audio:{$book}", 3600)->get(); // the corpse's lock
    writeProgressFile($book, [], 600);

    $this->actingAs($owner)
        ->postJson("/api/book-audio/{$book}/generate")
        ->assertStatus(202);

    Cache::lock("book-audio:{$book}")->forceRelease();
});

it('still refuses a genuinely concurrent run', function () {
    $owner = $this->seedUser(['credits' => 10, 'debits' => 0, 'status' => 'budget']);
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Some narratable text.</p>', 'plainText' => 'Some narratable text.',
    ]);

    Cache::lock("book-audio:{$book}", 3600)->get();
    writeProgressFile($book, [], 5); // warm — someone really is generating

    $this->actingAs($owner)
        ->postJson("/api/book-audio/{$book}/generate")
        ->assertStatus(409);

    Cache::lock("book-audio:{$book}")->forceRelease();
});

// ---------------------------------------------------------------------------
// Billing: a killed run must not leave the user paying for nothing
// ---------------------------------------------------------------------------

it('reaps a credit hold left behind by a job that was killed outright', function () {
    // Neither finally nor failed() runs on a SIGKILL, so the hold — a real
    // increment of users.debits — would otherwise sit there forever.
    $owner = $this->seedUser(['credits' => 10, 'debits' => 0, 'status' => 'budget']);
    actAsStallBillingUser($owner);
    $hold = app(BillingService::class)->reserveCredits($owner, 2.00, 'Audio generation reservation: dead-book');
    expect($hold)->not->toBeNull();
    expect((float) User::find($owner->id)->debits)->toBeGreaterThan(0.0);

    // Age it past the reaper's window.
    DB::table('billing_ledger')
        ->where('id', $hold->id)
        ->update(['created_at' => now()->subHours(3)]);

    $this->artisan('billing:reap-reservations --connection='.DB::getDefaultConnection())->assertExitCode(0);

    expect((float) User::find($owner->id)->debits)->toEqualWithDelta(0.0, 0.0001);
    expect(DB::table('billing_ledger')->where('id', $hold->id)->count())->toBe(0);
});

it('leaves a fresh hold alone — that job may still be running', function () {
    $owner = $this->seedUser(['credits' => 10, 'debits' => 0, 'status' => 'budget']);
    actAsStallBillingUser($owner);
    $hold = app(BillingService::class)->reserveCredits($owner, 2.00, 'Audio generation reservation: live-book');
    $before = (float) User::find($owner->id)->debits;

    $this->artisan('billing:reap-reservations --connection='.DB::getDefaultConnection())->assertExitCode(0);

    expect((float) User::find($owner->id)->debits)->toEqualWithDelta($before, 0.0001);
    expect(DB::table('billing_ledger')->where('id', $hold->id)->count())->toBe(1);
});

it('never reverses a REAL charge, only reservation holds', function () {
    $owner = $this->seedUser(['credits' => 10, 'debits' => 0, 'status' => 'budget']);
    actAsStallBillingUser($owner);
    app(BillingService::class)->charge($owner, 1.00, 'tts', 'A real narration charge');
    $chargedDebits = (float) User::find($owner->id)->debits;
    expect($chargedDebits)->toBeGreaterThan(0.0);

    DB::table('billing_ledger')
        ->update(['created_at' => now()->subHours(5)]); // age EVERYTHING

    $this->artisan('billing:reap-reservations --connection='.DB::getDefaultConnection())->assertExitCode(0);

    expect((float) User::find($owner->id)->debits)->toEqualWithDelta($chargedDebits, 0.0001);
});

it('changes nothing on a dry run', function () {
    $owner = $this->seedUser(['credits' => 10, 'debits' => 0, 'status' => 'budget']);
    actAsStallBillingUser($owner);
    $hold = app(BillingService::class)->reserveCredits($owner, 2.00, 'Audio generation reservation: dry');
    DB::table('billing_ledger')
        ->where('id', $hold->id)->update(['created_at' => now()->subHours(3)]);
    $before = (float) User::find($owner->id)->debits;

    $this->artisan('billing:reap-reservations --dry-run --connection='.DB::getDefaultConnection())->assertExitCode(0);

    expect((float) User::find($owner->id)->debits)->toEqualWithDelta($before, 0.0001);
    expect(DB::table('billing_ledger')->where('id', $hold->id)->count())->toBe(1);
});

// ---------------------------------------------------------------------------
// Self-continuation: a long book must never reach the timeout
// ---------------------------------------------------------------------------

it('heartbeats between provider calls, so a slow batch is never mistaken for a corpse', function () {
    // The staleness rule must be longer than the longest a WORKING run can go
    // quiet, or a struggling batch gets declared dead and a second job starts
    // and re-pays for the same nodes. One provider call (120s) is the bound —
    // the job re-stamps progress between sequential attempts and between the
    // segments of a split node.
    $owner = $this->seedUser(['credits' => 10, 'debits' => 0, 'status' => 'budget']);
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $this->seedNode([
        'book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1',
        'content' => '<p>Slow to narrate.</p>', 'plainText' => 'Slow to narrate.',
    ]);

    $store = app(BookAudioStore::class);
    // A provider that fails once (forcing the sequential retry path) and
    // records the heartbeat it saw at that moment.
    $seenDuringRetry = null;
    $flaky = new class($store, $book, $seenDuringRetry) implements \App\Services\Tts\TtsProviderInterface
    {
        public int $calls = 0;

        public function __construct(private $store, private string $book, public &$seen) {}

        public function synthesize(string $text, string $voice): \App\Services\Tts\TtsResult
        {
            $this->calls++;
            if ($this->calls === 1) {
                throw new RuntimeException('provider timeout');
            }
            $path = $this->store->progressPath($this->book);
            $this->seen = is_file($path) ? (json_decode(File::get($path), true)['updated_at'] ?? null) : null;

            return new \App\Services\Tts\TtsResult(bytes: 'FAKEMP3');
        }

        public function synthesizeBatch(array $textsByKey, string $voice): array
        {
            $out = [];
            foreach ($textsByKey as $key => $text) {
                try {
                    $out[$key] = $this->synthesize($text, $voice);
                } catch (\Throwable) {
                    $out[$key] = null;
                }
            }

            return $out;
        }

        public function maxCharsPerRequest(): int
        {
            return 1500;
        }
    };

    (new GenerateBookAudioJob($book, $owner->id, 'af_heart'))->handle($store, $flaky);

    // A heartbeat existed while the retry was in flight — that is what keeps a
    // slow run from being reaped.
    expect($flaky->seen)->not->toBeNull();
});

it('will not pay twice for a node another run narrated mid-flight', function () {
    // $pending is snapshotted once at startup, so two overlapping runs both
    // considered the same nodes outstanding and both called the provider —
    // paying twice for one node. One batch per node here, and the "rival run"
    // writes node 2's audio WHILE node 1 is being synthesized, i.e. after the
    // snapshot: only the per-batch re-check can catch that.
    config(['services.tts.concurrency' => 1]);

    $owner = $this->seedUser(['credits' => 10, 'debits' => 0, 'status' => 'budget']);
    $book = stalledBook();
    $this->seedLibrary([
        'book' => $book, 'creator' => $owner->name,
        'creator_token' => $owner->user_token, 'visibility' => 'public',
    ]);
    $one = 'First paragraph to narrate.';
    $two = 'Second paragraph to narrate.';
    $this->seedNode(['book' => $book, 'startLine' => 1, 'node_id' => $book.'_n1', 'content' => "<p>{$one}</p>", 'plainText' => $one]);
    $this->seedNode(['book' => $book, 'startLine' => 2, 'node_id' => $book.'_n2', 'content' => "<p>{$two}</p>", 'plainText' => $two]);

    $store = app(BookAudioStore::class);
    $rival = new class($store, $book, $two) implements \App\Services\Tts\TtsProviderInterface
    {
        public array $synthesized = [];

        public function __construct(private $store, private string $book, private string $two) {}

        public function synthesize(string $text, string $voice): \App\Services\Tts\TtsResult
        {
            $this->synthesized[] = $text;
            if (count($this->synthesized) === 1) {
                // The other run finishes node 2 while we are busy with node 1.
                $speakable = \App\Services\Tts\SpeakableText::fromContent("<p>{$this->two}</p>");
                $this->store->putNodeAudio(
                    $this->book, $this->book.'_n2', 'RIVALMP3',
                    hash('sha256', $speakable), 'af_heart', mb_strlen($speakable), 1000,
                );
            }

            return new \App\Services\Tts\TtsResult(bytes: 'FAKEMP3');
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

    (new GenerateBookAudioJob($book, $owner->id, 'af_heart'))->handle($store, $rival);

    expect($rival->synthesized, 'node 2 was skipped, not re-paid for')->toHaveCount(1);
    expect($rival->synthesized[0])->toContain('First paragraph');
});

it('hands the remaining work to a fresh job instead of being killed at the timeout', function () {
    // At ~270 chars/sec a book over ~1M characters cannot finish inside the
    // 3600s timeout. Reaching it loses finally/failed() — which is what
    // stranded the lock, the hold and the progress file in the first place.
    $budget = (new ReflectionClass(GenerateBookAudioJob::class))
        ->getConstant('WORK_BUDGET_SECONDS');

    expect($budget)->toBeLessThan((new GenerateBookAudioJob('b', null, 'af_heart'))->timeout);
    // Enough headroom for the trailing charge + progress writes.
    expect((new GenerateBookAudioJob('b', null, 'af_heart'))->timeout - $budget)->toBeGreaterThanOrEqual(300);
});
