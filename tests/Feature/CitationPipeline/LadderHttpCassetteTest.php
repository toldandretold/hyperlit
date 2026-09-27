<?php

/**
 * The HTTP layer of the characterisation harness, proved offline.
 *
 * The seam is the `Http` facade rather than the service methods because
 * `BraveSearchService::searchAndFetchBatch` creates library stub rows and returns their ids —
 * cassetting it at the method level would replay ids for rows that were never created. Taping one
 * level down means stub creation, scoring and every database write run FOR REAL on replay, and only
 * what the outside world said comes off the disk.
 *
 * These tests fake the "real" network with a stub so the recorder can be exercised without spending
 * money, then replay the tape and assert the same bytes come back with the network unreachable.
 */

use App\Services\CitationPipeline\Testing\LadderCassette;
use App\Services\CitationPipeline\Testing\LadderHttpCassette;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    // globalMiddleware accumulates on the Factory singleton, so each test gets a fresh one or the
    // previous test's recorder is still taping.
    Http::swap(new Factory());
});

function recordThrough(LadderCassette $cassette, callable $work): void
{
    (new LadderHttpCassette($cassette))->install();
    $work();
}

test('a GET is taped and replays byte for byte with the network unreachable', function () {
    Http::fake(['api.example.test/*' => Http::response('{"results":[{"id":"W123"}]}', 200, ['content-type' => 'application/json'])]);

    $cassette = LadderCassette::recording();
    recordThrough($cassette, fn () => Http::get('https://api.example.test/works', ['search' => 'Capital', 'per_page' => 5]));

    expect($cassette->stats()['entries'])->toBe(1);

    $path = sys_get_temp_dir() . '/ladder-http-' . bin2hex(random_bytes(6)) . '.json';
    $cassette->save($path);

    // A brand new Factory with NO passthrough — anything not served by the cassette would fail.
    Http::swap(new Factory());
    (new LadderHttpCassette(LadderCassette::replaying($path)))->install();

    $replayed = Http::get('https://api.example.test/works', ['search' => 'Capital', 'per_page' => 5]);

    expect($replayed->status())->toBe(200)
        ->and($replayed->json('results.0.id'))->toBe('W123');

    unlink($path);
});

test('query parameter order is not a different request', function () {
    // Guzzle does not guarantee parameter order across a rebuild, and a pure reorder is the same
    // question. If order mattered, the cassette would miss on a refactor that touched nothing.
    Http::fake(['*' => Http::response('ok')]);

    $cassette = LadderCassette::recording();
    recordThrough($cassette, fn () => Http::get('https://api.example.test/works', ['search' => 'x', 'per_page' => 5]));

    $path = sys_get_temp_dir() . '/ladder-http-' . bin2hex(random_bytes(6)) . '.json';
    $cassette->save($path);

    Http::swap(new Factory());
    (new LadderHttpCassette(LadderCassette::replaying($path)))->install();

    expect(Http::get('https://api.example.test/works', ['per_page' => 5, 'search' => 'x'])->body())->toBe('ok');

    unlink($path);
});

test('a different POST body is a different request', function () {
    // Two LLM calls to one endpoint differ only in their body; keying that away would serve one
    // citation's answer for another's prompt.
    Http::fake(['*' => Http::response('first')]);

    $cassette = LadderCassette::recording();
    recordThrough($cassette, fn () => Http::post('https://llm.example.test/v1/chat', ['prompt' => 'A']));

    $path = sys_get_temp_dir() . '/ladder-http-' . bin2hex(random_bytes(6)) . '.json';
    $cassette->save($path);

    Http::swap(new Factory());
    $replay = LadderCassette::replaying($path);
    (new LadderHttpCassette($replay))->install();

    // A miss is reported, NOT thrown. This callback runs inside Guzzle's promise chain, whose
    // `otherwise()` handler is typed `OutOfBoundsException|TransferException` — throwing anything
    // else there surfaces as a TypeError about an argument and destroys the message. The synthetic
    // status carries it out; the command fails the run on misses > 0.
    expect(Http::post('https://llm.example.test/v1/chat', ['prompt' => 'A'])->body())->toBe('first')
        ->and(Http::post('https://llm.example.test/v1/chat', ['prompt' => 'B'])->status())
        ->toBe(LadderHttpCassette::MISS_STATUS)
        ->and($replay->misses())->toHaveCount(1)
        ->and($replay->misses()[0]['key'])->toContain('llm.example.test/v1/chat');

    unlink($path);
});

test('a pooled batch is taped per request, so the ladder can re-batch freely', function () {
    // OpenAlex and Brave both issue their batches through Http::pool. Pool builds through the same
    // Factory, so the recorder sees each request individually — which is what lets the wave
    // extraction regroup them without invalidating the tape.
    Http::fake([
        'api.example.test/a*' => Http::response('A'),
        'api.example.test/b*' => Http::response('B'),
    ]);

    $cassette = LadderCassette::recording();
    recordThrough($cassette, fn () => Http::pool(fn ($pool) => [
        $pool->get('https://api.example.test/a'),
        $pool->get('https://api.example.test/b'),
    ]));

    expect($cassette->stats()['entries'])->toBe(2);

    $path = sys_get_temp_dir() . '/ladder-http-' . bin2hex(random_bytes(6)) . '.json';
    $cassette->save($path);

    // Replayed as two INDIVIDUAL gets rather than a pool.
    Http::swap(new Factory());
    (new LadderHttpCassette(LadderCassette::replaying($path)))->install();

    expect(Http::get('https://api.example.test/a')->body())->toBe('A')
        ->and(Http::get('https://api.example.test/b')->body())->toBe('B');

    unlink($path);
});

test('a binary body survives the JSON round trip', function () {
    // PDFs come back down this path; a raw JSON encode would corrupt them.
    $pdf = "%PDF-1.4\n" . random_bytes(64) . "\n%%EOF";
    Http::fake(['*' => Http::response($pdf, 200, ['content-type' => 'application/pdf'])]);

    $cassette = LadderCassette::recording();
    recordThrough($cassette, fn () => Http::get('https://files.example.test/x.pdf'));

    $path = sys_get_temp_dir() . '/ladder-http-' . bin2hex(random_bytes(6)) . '.json';
    $cassette->save($path);

    Http::swap(new Factory());
    (new LadderHttpCassette(LadderCassette::replaying($path)))->install();

    expect(Http::get('https://files.example.test/x.pdf')->body())->toBe($pdf);

    unlink($path);
});

test('a non-200 replays as its real status, not as a failure to record', function () {
    // A 403 from a publisher is EVIDENCE — "a live source refused us" — and the ladder branches on
    // it. Replaying it as anything else would change which rung runs next.
    Http::fake(['*' => Http::response('Forbidden', 403)]);

    $cassette = LadderCassette::recording();
    recordThrough($cassette, fn () => Http::get('https://walled.example.test/article'));

    $path = sys_get_temp_dir() . '/ladder-http-' . bin2hex(random_bytes(6)) . '.json';
    $cassette->save($path);

    Http::swap(new Factory());
    (new LadderHttpCassette(LadderCassette::replaying($path)))->install();

    expect(Http::get('https://walled.example.test/article')->status())->toBe(403);

    unlink($path);
});
