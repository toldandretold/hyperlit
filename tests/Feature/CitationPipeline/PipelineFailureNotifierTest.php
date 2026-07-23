<?php

/**
 * PipelineFailureNotifier — the "never leave the user in the breach" contract.
 * Whatever kills a citation pipeline (job failure, stale timeout, empty
 * result), exactly one apology email reaches the user and exactly one bug
 * report reaches the maintainer, and the pipeline row ends 'failed' — never
 * the silent "completed with no report and no email" black hole of the
 * 2026-07-23 incident (import_1784794368772).
 */

use App\Jobs\CitationPipelineJob;
use App\Mail\CitationPipelineBugReportMail;
use App\Mail\CitationReviewFailedMail;
use App\Services\CitationPipeline\PipelineFailureNotifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

uses(\Tests\Support\SeedsRlsFixtures::class);

function pfnDb()
{
    return DB::connection('pgsql_admin');
}

function pfnSeedPipeline(string $book, array $opts = []): string
{
    $id = (string) Str::uuid();
    pfnDb()->table('citation_pipelines')->insert(array_merge([
        'id'         => $id,
        'book'       => $book,
        'status'     => 'failed',
        'error'      => 'Something broke',
        'telemetry'  => json_encode([
            ['stage' => 'bibliography', 'status' => 'completed', 'at' => now()->toDateTimeString()],
            ['stage' => 'review', 'status' => 'failed', 'detail' => 'boom', 'at' => now()->toDateTimeString()],
        ]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts));
    return $id;
}

afterEach(function () {
    pfnDb()->table('citation_pipelines')->where('book', 'like', 'apitest\_pfn\_%')->delete();
    pfnDb()->table('bibliography')->where('book', 'like', 'apitest\_pfn\_%')->delete();
    pfnDb()->table('nodes')->where('book', 'like', 'apitest\_pfn\_%')->delete();
    $this->cleanupRlsFixtures();
});

test('notify sends the user apology and the maintainer bug report exactly once', function () {
    Mail::fake();
    $user = $this->seedUser();
    $book = 'apitest_pfn_' . Str::random(6);
    $this->seedLibrary(['book' => $book, 'title' => 'PFN Book', 'creator' => $user->name]);
    $id = pfnSeedPipeline($book, ['user_id' => $user->id]);

    $notifier = new PipelineFailureNotifier();
    $notifier->notify($id);

    Mail::assertSent(CitationReviewFailedMail::class, function (CitationReviewFailedMail $m) use ($user) {
        $m->build();
        return $m->hasTo($user->email);
    });
    Mail::assertSent(CitationPipelineBugReportMail::class, function (CitationPipelineBugReportMail $m) {
        $m->build();
        return $m->hasTo(config('mail.maintainer_alert'));
    });
    expect(pfnDb()->table('citation_pipelines')->where('id', $id)->value('failure_notified_at'))
        ->not->toBeNull();

    // Latch: a second notify (concurrent poller, job retry) sends nothing more
    $notifier->notify($id);
    Mail::assertSent(CitationReviewFailedMail::class, 1);
    Mail::assertSent(CitationPipelineBugReportMail::class, 1);
});

test('notify falls back to the book creator when the pipeline has no user_id', function () {
    Mail::fake();
    $user = $this->seedUser();
    $book = 'apitest_pfn_' . Str::random(6);
    $this->seedLibrary(['book' => $book, 'title' => 'PFN Book', 'creator' => $user->name]);
    $id = pfnSeedPipeline($book);

    (new PipelineFailureNotifier())->notify($id);

    Mail::assertSent(CitationReviewFailedMail::class, function (CitationReviewFailedMail $m) use ($user) {
        $m->build();
        return $m->hasTo($user->email);
    });
});

test('notify never throws: null id and unknown id are safe no-ops', function () {
    Mail::fake();
    $notifier = new PipelineFailureNotifier();
    $notifier->notify(null);
    $notifier->notify((string) Str::uuid());
    Mail::assertNothingOutgoing();
});

test('a permanently failed job notifies via failed()', function () {
    Mail::fake();
    $user = $this->seedUser();
    $book = 'apitest_pfn_' . Str::random(6);
    $this->seedLibrary(['book' => $book, 'title' => 'PFN Book', 'creator' => $user->name]);
    $id = pfnSeedPipeline($book, ['status' => 'running', 'user_id' => $user->id]);

    (new CitationPipelineJob($book, $id))->failed(new RuntimeException('LLM exploded'));

    $row = pfnDb()->table('citation_pipelines')->where('id', $id)->first();
    expect($row->status)->toBe('failed');
    expect($row->error)->toBe('LLM exploded');
    Mail::assertSent(CitationReviewFailedMail::class, 1);
    Mail::assertSent(CitationPipelineBugReportMail::class, 1);
});

test('the stale auto-fail in the status poll notifies', function () {
    Mail::fake();
    $user = $this->seedUser();
    $book = 'apitest_pfn_' . Str::random(6);
    $this->seedLibrary(['book' => $book, 'title' => 'PFN Book', 'creator' => $user->name]);
    $id = pfnSeedPipeline($book, [
        'status' => 'pending', 'error' => null,
        'user_id' => $user->id, 'updated_at' => now()->subMinutes(10),
    ]);

    $this->actingAs($user)
        ->getJson("/api/citation-pipeline/status/{$id}")
        ->assertOk()
        ->assertJsonPath('pipeline.status', 'failed');

    Mail::assertSent(CitationReviewFailedMail::class, 1);
    Mail::assertSent(CitationPipelineBugReportMail::class, 1);

    // Subsequent polls of the now-failed pipeline don't re-send
    $this->actingAs($user)->getJson("/api/citation-pipeline/status/{$id}")->assertOk();
    Mail::assertSent(CitationReviewFailedMail::class, 1);
});

test('an empty review (0 claims) fails the pipeline, emails, and survives the job completed-update', function () {
    Mail::fake();
    config(['services.llm.api_key' => 'test-key']);

    $user = $this->seedUser();
    $book = 'apitest_pfn_' . Str::random(6);
    $this->seedLibrary(['book' => $book, 'title' => 'PFN Book', 'creator' => $user->name, 'has_nodes' => true]);
    // A resolved bibliography (passes pre-flight) but NO citation-bearing nodes
    pfnDb()->table('bibliography')->insert([
        'book' => $book, 'referenceId' => 'ruggie1982', 'content' => 'Ruggie 1982',
        'foundation_source' => 'some_source_book', 'created_at' => now(), 'updated_at' => now(),
    ]);
    pfnDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $book . '_n1', 'chunk_id' => 1, 'startLine' => 1,
        'content' => '<p>No citations here at all.</p>', 'plainText' => 'No citations here at all.',
        'type' => 'p', 'created_at' => now(), 'updated_at' => now(),
    ]);
    $id = pfnSeedPipeline($book, ['status' => 'running', 'error' => null, 'user_id' => $user->id]);

    $exit = $this->artisan('citation:review', ['bookId' => $book, '--pipeline-id' => $id])->run();
    expect($exit)->toBe(0); // exit 0 on purpose — no retry burn

    $row = pfnDb()->table('citation_pipelines')->where('id', $id)->first();
    expect($row->status)->toBe('failed');
    expect($row->error)->toContain('no claims');

    // The review stage's LAST telemetry event is the failure (viz paints red)
    $events = collect(json_decode($row->telemetry, true))->where('stage', 'review');
    expect($events->last()['status'])->toBe('failed');

    Mail::assertSent(CitationReviewFailedMail::class, 1);
    Mail::assertSent(CitationPipelineBugReportMail::class, 1);

    // The job's completed-update must NOT flip the settled failure back
    pfnDb()->table('citation_pipelines')->where('id', $id)
        ->whereIn('status', ['pending', 'running'])
        ->update(['status' => 'completed']);
    expect(pfnDb()->table('citation_pipelines')->where('id', $id)->value('status'))->toBe('failed');
});
