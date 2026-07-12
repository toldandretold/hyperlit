<?php

/**
 * FlareSolverrClient — the opt-in, self-hosted Cloudflare-solver seam. The
 * whole strategy no-ops when FLARESOLVERR_URL is unset (dev/prod without the
 * container behave as before); when set, a solve returns the cleared session.
 */

use App\Services\SourceImport\Content\FlareSolverrClient;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

uses(TestCase::class);

test('is not configured (and solve no-ops) when FLARESOLVERR_URL is unset', function () {
    config(['services.flaresolverr.url' => null]);
    $client = new FlareSolverrClient();
    expect($client->isConfigured())->toBeFalse();
    expect($client->solve('https://direct.mit.edu/x'))->toBeNull();
});

test('solve returns the cleared cookies + user-agent + html on ok', function () {
    config(['services.flaresolverr.url' => 'http://127.0.0.1:8191']);
    Http::fake([
        '127.0.0.1:8191/v1' => Http::response([
            'status'   => 'ok',
            'solution' => [
                'url'       => 'https://direct.mit.edu/article',
                'response'  => '<html><meta name="citation_pdf_url" content="https://direct.mit.edu/x.pdf"></html>',
                'userAgent' => 'Mozilla/5.0 SolvedUA',
                'cookies'   => [['name' => 'cf_clearance', 'value' => 'abc123']],
            ],
        ]),
    ]);

    $solved = (new FlareSolverrClient())->solve('https://direct.mit.edu/article');

    expect($solved)->not->toBeNull();
    expect($solved['user_agent'])->toBe('Mozilla/5.0 SolvedUA');
    expect($solved['cookies'][0]['name'])->toBe('cf_clearance');
    expect($solved['html'])->toContain('citation_pdf_url');
});

test('solve returns null when FlareSolverr reports a non-ok status', function () {
    config(['services.flaresolverr.url' => 'http://127.0.0.1:8191']);
    Http::fake([
        '127.0.0.1:8191/v1' => Http::response(['status' => 'error', 'message' => 'challenge not solved']),
    ]);
    expect((new FlareSolverrClient())->solve('https://x'))->toBeNull();
});
