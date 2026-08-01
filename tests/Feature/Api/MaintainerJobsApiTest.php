<?php

/**
 * The /maintainer/jobs triage page + its API: admin-only everywhere (the web
 * page 404s for non-admins, matching /maintainer/conversion), failures arrive
 * GROUPED by job class + normalised exception (the whole point — 87 rows were
 * really 5 bugs), forget deletes the group's rows, retrying a PAID class
 * demands explicit confirmation because it re-runs billable API work, and the
 * export endpoint hands down a case bundle.
 *
 * Also locks the namespace move: bare /maintainer must keep redirecting with
 * its query string intact, because already-sent flag emails deep-link
 * /maintainer?book=<id>.
 */

use App\Services\System\FailureDigest;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

afterEach(function () {
    DB::table('failed_jobs')->where('queue', 'like', 'jobstest%')->delete();
    File::deleteDirectory(storage_path('app/failure-exports'));
});

/** Insert a failed_jobs row shaped like the real thing. */
function seedFailure(string $jobClass, string $exception, string $failedAt, string $book = null): int
{
    return DB::table('failed_jobs')->insertGetId([
        'uuid' => (string) Illuminate\Support\Str::uuid(),
        'connection' => 'database',
        'queue' => 'jobstest',
        'payload' => json_encode([
            'displayName' => $jobClass,
            'job' => 'Illuminate\Queue\CallQueuedHandler@call',
            'data' => [
                'commandName' => $jobClass,
                'command' => 'O:30:"' . $jobClass . '":1:{s:4:"book";s:' . strlen((string) $book) . ':"' . $book . '";}',
            ],
        ]),
        'exception' => $exception,
        'failed_at' => $failedAt,
    ]);
}

// ── Namespace move ────────────────────────────────────────────────────────

test('bare /maintainer redirects to the conversion page, keeping the deep link', function () {
    // Flag emails already in inboxes point at /maintainer?book=<id>.
    $this->get('/maintainer?book=book_123')
        ->assertRedirect('/maintainer/conversion?book=book_123');

    $this->get('/maintainer')->assertRedirect('/maintainer/conversion');
});

// ── Admin gating ──────────────────────────────────────────────────────────

test('the /maintainer/jobs page 404s for guests and non-admins, renders for admins', function () {
    $this->get('/maintainer/jobs')->assertNotFound();

        $this->loginUser(); // authenticated but NOT admin
    $this->get('/maintainer/jobs')->assertNotFound();

        $this->loginUser(['is_admin' => true]);
    $this->get('/maintainer/jobs')->assertOk()->assertViewIs('maintainer-jobs')->assertSee('Job failures');
});

test('every jobs API endpoint is admin-gated', function () {
        $this->loginUser(); // authenticated but NOT admin

    $this->getJson('/api/maintainer/jobs/failures')->assertStatus(403);
    $this->postJson('/api/maintainer/jobs/seen')->assertStatus(403);
    $this->postJson('/api/maintainer/jobs/abcdef123456/retry')->assertStatus(403);
    $this->deleteJson('/api/maintainer/jobs/abcdef123456')->assertStatus(403);
    $this->getJson('/api/maintainer/jobs/abcdef123456/export')->assertStatus(403);
});

// ── Grouping: the actual product ──────────────────────────────────────────

test('failures with the same cause collapse into one group despite volatile detail', function () {
    // The real case: the same log-permission fault 3 times, each naming a
    // different absolute path/line — one bug, not three.
    seedFailure(
        'App\Jobs\UpdateHomepageJob',
        'UnexpectedValueException: The stream or file "/var/www/hyperlit/storage/logs/laravel.log" could not be opened in append mode in /var/www/x.php:1734567890',
        '2026-07-01 06:45:02',
    );
    seedFailure(
        'App\Jobs\UpdateHomepageJob',
        'UnexpectedValueException: The stream or file "/var/www/hyperlit/storage/logs/laravel.log" could not be opened in append mode in /var/www/y.php:9876543210',
        '2026-07-02 06:45:02',
    );
    seedFailure(
        'App\Jobs\UpdateHomepageJob',
        'PDOException: SQLSTATE[23505]: Unique violation: duplicate key value violates unique constraint "library_pkey"',
        '2026-07-03 07:50:29',
    );

    $groups = collect(app(FailureDigest::class)->groups())
        ->filter(fn ($g) => $g['job_class'] === 'App\Jobs\UpdateHomepageJob');

    expect($groups)->toHaveCount(2);

    $stream = $groups->firstWhere('count', 2);
    expect($stream)->not->toBeNull()
        ->and($stream['first_seen'])->toContain('2026-07-01')
        ->and($stream['last_seen'])->toContain('2026-07-02')
        ->and($stream['paid'])->toBeFalse();
});

test('the failures endpoint reports groups, and books are pulled out of the payload', function () {
    seedFailure(
        'App\Jobs\ProcessDocumentImportJob',
        'RuntimeException: nodes.jsonl was not created after processing',
        '2026-07-14 10:54:25',
        'book_1757846828811',
    );

    $this->loginUser(['is_admin' => true]);

    $group = collect($this->getJson('/api/maintainer/jobs/failures')->assertOk()->json('groups'))
        ->firstWhere('job_name', 'ProcessDocumentImportJob');

    expect($group)->not->toBeNull()
        ->and($group['books'])->toContain('book_1757846828811')
        ->and($group['paid'])->toBeTrue();  // imports run paid OCR
});

// ── Actions ───────────────────────────────────────────────────────────────

test('retrying a paid group requires explicit confirmation', function () {
    seedFailure('App\Jobs\CitationPipelineJob', 'RuntimeException: citation:pipeline exited with code 1', '2026-07-23 10:00:43');

    $this->loginUser(['is_admin' => true]);
    $key = app(FailureDigest::class)->keyFor('App\Jobs\CitationPipelineJob', 'RuntimeException: citation:pipeline exited with code 1');

    // Without the flag: refused, and told why.
    $this->postJson("/api/maintainer/jobs/{$key}/retry")
        ->assertStatus(422)
        ->assertJson(['needs_confirm' => true]);

    // The rows are still there — a refused retry must not consume them.
    expect(DB::table('failed_jobs')->where('queue', 'jobstest')->count())->toBe(1);
});

test('forgetting a group deletes exactly that group', function () {
    seedFailure('App\Jobs\DailyStatsJob', 'UnexpectedValueException: The stream or file "/x/laravel.log" could not be opened in append mode', '2026-06-12 08:00:07');
    seedFailure('App\Jobs\QueueBookEmbeddings', 'Illuminate\Queue\TimeoutExceededException: has timed out', '2026-04-23 08:36:27');

    $this->loginUser(['is_admin' => true]);
    $key = collect(app(FailureDigest::class)->groups())->firstWhere('job_name', 'DailyStatsJob')['key'];

    $this->deleteJson("/api/maintainer/jobs/{$key}")->assertOk()->assertJson(['forgotten' => 1]);

    expect(DB::table('failed_jobs')->where('queue', 'jobstest')->count())->toBe(1);
    expect(collect(app(FailureDigest::class)->groups())->firstWhere('job_name', 'DailyStatsJob'))->toBeNull();
});

test('export builds a case bundle carrying the trace and the prompt', function () {
    seedFailure(
        'App\Jobs\SourceNetworkHarvestJob',
        'PDOException: SQLSTATE[22001]: String data, right truncated: value too long for type character varying(20)',
        '2026-07-14 19:26:38',
        'book_1781172598359',
    );

    $this->loginUser(['is_admin' => true]);
    $key = collect(app(FailureDigest::class)->groups())->firstWhere('job_name', 'SourceNetworkHarvestJob')['key'];

    $resp = $this->get("/api/maintainer/jobs/{$key}/export");
    $resp->assertOk()->assertDownload("failure-{$key}.tar.gz");

    // Unpack it and check the pieces a debugger actually needs are present.
    $dir = storage_path('app/failure-exports/verify');
    File::ensureDirectoryExists($dir);
    exec(sprintf('tar -xzf %s -C %s', escapeshellarg(storage_path("app/failure-exports/{$key}.tar.gz")), escapeshellarg($dir)));

    expect(File::exists("{$dir}/README.md"))->toBeTrue()
        ->and(File::exists("{$dir}/exception.txt"))->toBeTrue()
        ->and(File::exists("{$dir}/failures.json"))->toBeTrue()
        ->and(File::get("{$dir}/exception.txt"))->toContain('character varying(20)')
        ->and(File::get("{$dir}/books.txt"))->toContain('book_1781172598359');

    $context = json_decode(File::get("{$dir}/context.json"), true);
    expect($context['job_class'])->toBe('App\Jobs\SourceNetworkHarvestJob')
        ->and($context['count'])->toBe(1);

    // The README is the prompt — it must actually carry the case's specifics.
    expect(File::get("{$dir}/README.md"))
        ->toContain('SourceNetworkHarvestJob')
        ->toContain('If you are Claude');
});
