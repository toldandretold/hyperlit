<?php

/**
 * The metered rungs must be DARK in the test environment.
 *
 * Two of them cannot be stopped by `Http::fake()`, because they do not go
 * through the HTTP client at all: the managed unblocker shells out to `curl`
 * and the browser rung spawns a Node process. So a suite that merely fakes HTTP
 * is not protected — an unblocker URL leaking into `.env.testing` (or a
 * developer copying `.env` over it) would silently turn every 403-path test
 * into a live, billed request, and the only symptom would be a slower suite.
 *
 * Today's safety is incidental: `.env.testing` happens not to define
 * `UNBLOCKER_*`. This makes it deliberate.
 */

use App\Services\WebContent\UnblockerClient;

test('the managed unblocker is not configured under test', function () {
    // It bills per successful retrieval, and curl is invisible to Http::fake.
    expect(config('services.unblocker.url'))->toBeEmpty(
        'UNBLOCKER_URL is set in the test environment — tests would make live, billed requests'
    );

    expect(app(UnblockerClient::class)->isConfigured())->toBeFalse();
});

test('the headless browser rung is off, or individually disabled per test', function () {
    // The browser spends real time and residential-proxy bandwidth, and a Node
    // subprocess cannot be intercepted either. Suites that exercise the fetch
    // ladder switch it off in beforeEach; this records that the default has not
    // silently become "on with credentials" for the whole test run.
    $browser = config('services.source_fetch.browser');
    $proxy = config('services.source_fetch.proxy');

    expect($browser === false || $proxy === null || $proxy === '')->toBeTrue(
        'the test environment has BOTH the browser rung on and a proxy configured — '
        . 'fetch-ladder tests would spend metered bandwidth'
    );
});

test('Brave web search is not configured under test', function () {
    // Same class of silent spend: Brave bills per request, including the ones
    // that return nothing.
    expect(config('services.brave_search.api_key'))->toBeEmpty(
        'BRAVE_SEARCH_API_KEY is set in the test environment — resolution tests would bill real searches'
    );
});
