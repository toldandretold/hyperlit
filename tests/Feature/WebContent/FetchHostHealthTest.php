<?php

/**
 * Per-host memory of "can we read this publisher, and what have we tried?"
 *
 * The cost this exists to stop: the acquisition ladder is now plain GET →
 * headless browser → managed unblocker → unblocker with JS rendering →
 * landing-page PDF hunt. Against a host that refuses all of it that is
 * **201 seconds per URL**, measured, and five such hosts were a large share of
 * a 39-minute 59-URL run while producing nothing. Without memory, every review
 * pays again to learn what the last one already knew.
 *
 * The second job matters more over time: the table is a RECORD of where effort
 * would pay. `citations_blocked` ranks publishers by what they have actually
 * cost, and `channels_tried` distinguishes a host worth one more technique from
 * one that has already refused everything we own.
 */

use App\Services\WebContent\FetchHostHealth;
use App\Services\WebContent\WebTextAcquirer;
use Illuminate\Support\Facades\DB;

beforeEach(function () {
    DB::connection('pgsql_admin')->table('fetch_host_reachability')->delete();
});

afterEach(function () {
    DB::connection('pgsql_admin')->table('fetch_host_reachability')->delete();
});

test('www and the apex domain are ONE publisher', function () {
    // chacko cites both `article-14.com` and `www.article-14.com`. Counting
    // them separately halves a host's apparent cost and hides it in the
    // ranking. (ProxyPolicy deliberately does NOT normalise, because a routing
    // decision is about the exact address asked — a different question.)
    expect(FetchHostHealth::hostOf('https://www.article-14.com/post/x'))->toBe('article-14.com')
        ->and(FetchHostHealth::hostOf('https://article-14.com/post/y'))->toBe('article-14.com')
        ->and(FetchHostHealth::hostOf('https://WWW.Economist.COM/foo?x=1'))->toBe('economist.com')
        ->and(FetchHostHealth::hostOf(null))->toBeNull()
        ->and(FetchHostHealth::hostOf('not a url'))->toBeNull();
});

test('only HOST-level outcomes are recorded — a 404 must not condemn a publisher', function () {
    $health = app(FetchHostHealth::class);

    $health->recordFailure('example.com', WebTextAcquirer::GRADE_DEAD, 'HTTP 404', 404);
    $health->recordFailure('example.com', WebTextAcquirer::GRADE_METADATA_ONLY, 'no article body', 200);
    $health->recordFailure('example.com', WebTextAcquirer::GRADE_IRRELEVANT, 'not this work', 200);

    expect($health->isCoolingOff('example.com'))->toBeFalse()
        ->and(DB::connection('pgsql_admin')->table('fetch_host_reachability')->count())->toBe(0);

    // Refused or unreachable IS about the host.
    $health->recordFailure('example.com', WebTextAcquirer::GRADE_BLOCKED, 'HTTP 403', 403);
    expect($health->isCoolingOff('example.com'))->toBeTrue();
});

test('the cooldown backs off and is never permanent', function () {
    $health = app(FetchHostHealth::class);

    foreach (range(1, 3) as $n) {
        $health->recordFailure('walled.test', WebTextAcquirer::GRADE_BLOCKED, 'HTTP 403', 403);
    }

    $row = DB::connection('pgsql_admin')->table('fetch_host_reachability')->where('host', 'walled.test')->first();

    expect((int) $row->consecutive_failures)->toBe(3)
        ->and((int) $row->citations_blocked)->toBe(3)
        // A ladder, not a life sentence: bot walls are often rate-based and a
        // host that refuses today may serve next month.
        ->and($row->retry_after)->not->toBeNull()
        ->and(strtotime((string) $row->retry_after))->toBeGreaterThan(time());
});

test('channels tried are UNIONED across attempts, never overwritten', function () {
    // An early wall short-circuits the ladder, so a later attempt may report
    // fewer rungs. Forgetting that the browser was already spent on this host
    // would make the record useless for deciding what to try next.
    $health = app(FetchHostHealth::class);

    $health->recordFailure('walled.test', WebTextAcquirer::GRADE_BLOCKED, 'wall', 403, ['plain', 'browser', 'unblocker_render']);
    $health->recordFailure('walled.test', WebTextAcquirer::GRADE_BLOCKED, 'wall', 403, ['plain']);

    $row = DB::connection('pgsql_admin')->table('fetch_host_reachability')->where('host', 'walled.test')->first();
    $channels = json_decode((string) $row->channels_tried, true);

    expect($channels)->toContain('browser')
        ->and($channels)->toContain('unblocker_render')
        ->and($channels)->toContain('plain');
});

test('a success lifts the cooldown but KEEPS the history', function () {
    // What a publisher cost us last month is worth remembering once it starts
    // working again — that is the difference between a skip-list and a record.
    $health = app(FetchHostHealth::class);
    $health->recordFailure('flaky.test', WebTextAcquirer::GRADE_BLOCKED, 'HTTP 403', 403);

    expect($health->isCoolingOff('flaky.test'))->toBeTrue();

    $health->recordSuccess('flaky.test');

    $row = DB::connection('pgsql_admin')->table('fetch_host_reachability')->where('host', 'flaky.test')->first();

    expect($health->isCoolingOff('flaky.test'))->toBeFalse()
        ->and((int) $row->consecutive_failures)->toBe(0)
        ->and($row->retry_after)->toBeNull()
        ->and((int) $row->successes)->toBe(1)
        // The cost is still on the record.
        ->and((int) $row->citations_blocked)->toBe(1);
});

test('the bench can ignore cooldowns, or it would measure our memory', function () {
    // `citation:web:bench` exists to say whether a change moved the needle. A
    // bench that silently skipped every known-bad host would report an
    // improvement that is really just this table remembering.
    $health = app(FetchHostHealth::class);
    $health->recordFailure('walled.test', WebTextAcquirer::GRADE_BLOCKED, 'HTTP 403', 403);

    expect($health->isCoolingOff('walled.test'))->toBeTrue();

    $health->ignoreCooldowns();
    expect($health->isCoolingOff('walled.test'))->toBeFalse();
});

test('a cooling-off host reports the KNOWN reason, not a fresh-looking failure', function () {
    // Otherwise the workbench would show a brand-new mystery every run instead
    // of "we already established this, here is what it said".
    config()->set('services.source_fetch.browser', false);

    app(FetchHostHealth::class)->recordFailure(
        'example.com',
        WebTextAcquirer::GRADE_BLOCKED,
        'HTTP 403 — refused with HTTP 403 (bot block, paywall, or rate limit)',
        403,
        ['plain', 'browser', 'unblocker', 'unblocker_render'],
    );

    $result = app(WebTextAcquirer::class)->acquire('https://example.com/some-article');

    expect($result['grade'])->toBe(WebTextAcquirer::GRADE_BLOCKED)
        ->and($result['channel'])->toBe('cooldown')
        ->and($result['reason'])->toContain('bot block')
        ->and($result['reason'])->toContain('previous attempt')
        ->and($result['http_status'])->toBe(403);
});

test('clearing a host lets it be retried after a new technique lands', function () {
    $health = app(FetchHostHealth::class);
    $health->recordFailure('walled.test', WebTextAcquirer::GRADE_BLOCKED, 'HTTP 403', 403);

    expect($health->clear('walled.test'))->toBe(1)
        ->and($health->isCoolingOff('walled.test'))->toBeFalse();
});
