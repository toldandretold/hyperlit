<?php

/**
 * PipelineTelemetry — the append-only event stream behind the live pipeline
 * visualisation. Contract: events append in order onto
 * citation_pipelines.telemetry, a null pipelineId no-ops, the stream is
 * capped, and a telemetry failure can never throw into the pipeline.
 */

use App\Services\CitationPipeline\PipelineTelemetry;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function telemDb()
{
    return DB::connection('pgsql_admin');
}

function telemSeedPipeline(): string
{
    $id = (string) Str::uuid();
    telemDb()->table('citation_pipelines')->insert([
        'id'         => $id,
        'book'       => 'apitest_telem_' . Str::random(8),
        'status'     => 'running',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return $id;
}

beforeEach(function () {
    telemDb()->table('citation_pipelines')->where('book', 'like', 'apitest\_telem\_%')->delete();
});

test('events append in order with stage, status, detail, signals and substage', function () {
    $id = telemSeedPipeline();
    $t = new PipelineTelemetry($id);

    $t->emit('bibliography', 'started', 'Scanning bibliography entries');
    $t->emit('bibliography', 'progress', 'Wave 4: OpenAlex', ['searched' => 12]);
    $t->emit('bibliography', 'completed');
    $t->emit('review', 'progress', 'Extracted 40 claims', [], 'extract');

    $events = json_decode(telemDb()->table('citation_pipelines')->where('id', $id)->value('telemetry'), true);

    expect($events)->toHaveCount(4);
    expect($events[0]['stage'])->toBe('bibliography');
    expect($events[0]['status'])->toBe('started');
    expect($events[1]['signals'])->toBe(['searched' => 12]);
    expect($events[2]['status'])->toBe('completed');
    expect($events[3]['substage'])->toBe('extract');
    expect($events[3]['at'])->not->toBeEmpty();
});

test('a second emitter (resume / next command in the chain) appends after existing events', function () {
    $id = telemSeedPipeline();

    (new PipelineTelemetry($id))->emit('bibliography', 'started');
    // Fresh instance, as when citation:review starts inside the same pipeline
    (new PipelineTelemetry($id))->emit('review', 'started');

    $events = json_decode(telemDb()->table('citation_pipelines')->where('id', $id)->value('telemetry'), true);
    expect(array_column($events, 'stage'))->toBe(['bibliography', 'review']);
});

test('interleaved emitters never clobber each other\'s events (read-append-write)', function () {
    // The pipeline command and the review command hold SEPARATE emitter
    // instances in the same process; queue retries reuse instances. Each emit
    // must append to the CURRENT stream, not a cached copy — otherwise the
    // pipeline command\'s final "review/completed" wipes every review
    // sub-stage event the review command appended.
    $id = telemSeedPipeline();
    $pipelineCmd = new PipelineTelemetry($id);
    $reviewCmd   = new PipelineTelemetry($id);

    $pipelineCmd->emit('review', 'started');
    $reviewCmd->emit('review', 'progress', 'Extracted 40 claims', [], 'extract');
    $reviewCmd->emit('review', 'progress', 'Created 40 highlights', [], 'highlights');
    $pipelineCmd->emit('review', 'completed'); // stale instance — must still see the two above

    $events = json_decode(telemDb()->table('citation_pipelines')->where('id', $id)->value('telemetry'), true);
    expect(array_column($events, 'status'))->toBe(['started', 'progress', 'progress', 'completed']);
    expect($events[1]['substage'])->toBe('extract');
});

test('null pipeline id makes every emit a no-op', function () {
    $t = new PipelineTelemetry(null);
    $t->emit('bibliography', 'started'); // must not throw, must not write
    expect(true)->toBeTrue();
});

test('a missing pipeline row never throws into the pipeline', function () {
    $t = new PipelineTelemetry((string) Str::uuid()); // row does not exist
    $t->emit('bibliography', 'started');
    expect(true)->toBeTrue();
});

test('the stream is capped at MAX_EVENTS with a trim marker', function () {
    $id = telemSeedPipeline();
    $t = new PipelineTelemetry($id);

    for ($i = 0; $i < PipelineTelemetry::MAX_EVENTS + 25; $i++) {
        $t->emit('vacuum', 'progress', "Fetching source {$i}");
    }

    $events = json_decode(telemDb()->table('citation_pipelines')->where('id', $id)->value('telemetry'), true);

    expect(count($events))->toBeLessThanOrEqual(PipelineTelemetry::MAX_EVENTS);
    expect(json_encode($events))->toContain('earlier events trimmed');
    // The freshest event survives the trim
    expect(end($events)['detail'])->toBe('Fetching source ' . (PipelineTelemetry::MAX_EVENTS + 24));
});
