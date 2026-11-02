<?php

use App\Mcp\TokenAbilities;
use App\Models\User;
use App\Services\CoreService;
use App\Services\OpenAlexService;
use App\Services\OpenLibraryService;
use App\Services\SemanticScholarService;
use App\Services\UnpaywallService;

/**
 * search_sources / find_full_text over the real /mcp endpoint. The external
 * clients are mocked out of the container (the tools resolve them via app()),
 * so these test the tool's shaping/merge/dedup, not live network calls.
 */

function bibToken(User $user, array $abilities = [TokenAbilities::READ]): string
{
    return $user->createToken('mcp bib', $abilities, now()->addYear())->plainTextToken;
}

function bibCall($test, string $token, string $tool, array $arguments)
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call',
        'params' => ['name' => $tool, 'arguments' => $arguments],
    ], ['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json, text/event-stream']);
}

function bibJson($response): array
{
    return json_decode((string) ($response->json('result.content.0.text') ?? ''), true) ?: [];
}

test('search_sources queries OpenAlex and shapes the candidates', function () {
    $user = $this->seedUser();
    $token = bibToken($user);

    $this->mock(OpenAlexService::class, function ($m) {
        $m->shouldReceive('fetchFromOpenAlex')->once()->andReturn([
            ['source' => 'openalex', 'title' => 'Governing the Commons', 'author' => 'Elinor Ostrom',
             'year' => 1990, 'journal' => null, 'doi' => '10.1017/cbo9780511807763', 'openalex_id' => 'W123',
             'type' => 'book', 'is_oa' => false, 'oa_url' => null, 'pdf_url' => null],
        ]);
    });

    $response = bibCall($this, $token, 'search_sources', ['query' => 'governing the commons']);
    expect($response->json('result.isError'))->not->toBeTrue();
    $json = bibJson($response);
    expect($json['count'])->toBe(1);
    expect($json['results'][0]['title'])->toBe('Governing the Commons');
    expect($json['results'][0]['doi'])->toBe('10.1017/cbo9780511807763');
    expect($json['results'][0]['openalex_id'])->toBe('W123');
});

test('search_sources with source=all merges all three databases, a failing one skipped', function () {
    $user = $this->seedUser();
    $token = bibToken($user);

    $this->mock(OpenAlexService::class, fn ($m) => $m->shouldReceive('fetchFromOpenAlex')
        ->andReturn([['source' => 'openalex', 'title' => 'A', 'year' => 2020]]));
    $this->mock(OpenLibraryService::class, fn ($m) => $m->shouldReceive('search')
        ->andReturn([['source' => 'open_library', 'title' => 'B', 'open_library_key' => 'OL1']]));
    // Semantic Scholar throws — must not sink the whole search.
    $this->mock(SemanticScholarService::class, fn ($m) => $m->shouldReceive('search')
        ->andThrow(new RuntimeException('rate limited')));

    $response = bibCall($this, $token, 'search_sources', ['query' => 'test', 'source' => 'all']);
    $json = bibJson($response);
    expect($json['count'])->toBe(2);
    expect(collect($json['results'])->pluck('title')->all())->toEqualCanonicalizing(['A', 'B']);
});

test('find_full_text merges and de-dupes OA locations across providers', function () {
    $user = $this->seedUser();
    $token = bibToken($user);

    $this->mock(UnpaywallService::class, fn ($m) => $m->shouldReceive('oaLocations')->andReturn([
        ['pdf_url' => 'https://repo.example/a.pdf', 'landing_page_url' => 'https://repo.example/a', 'host_type' => 'repository'],
    ]));
    $this->mock(CoreService::class, fn ($m) => $m->shouldReceive('oaLocations')->andReturn([
        // Duplicate pdf_url — must be de-duped.
        ['pdf_url' => 'https://repo.example/a.pdf', 'host_type' => 'repository'],
        ['pdf_url' => 'https://core.ac.uk/b.pdf', 'host_type' => 'repository'],
    ]));
    $this->mock(SemanticScholarService::class, fn ($m) => $m->shouldReceive('openAccessPdfByDoi')
        ->andReturn('https://s2.example/c.pdf'));

    $response = bibCall($this, $token, 'find_full_text', ['doi' => 'https://doi.org/10.5210/fm.v29i4.13637']);
    expect($response->json('result.isError'))->not->toBeTrue();
    $json = bibJson($response);
    // a.pdf (once), b.pdf, c.pdf = 3 unique.
    expect($json['count'])->toBe(3);
    expect($json['doi'])->toBe('10.5210/fm.v29i4.13637'); // scheme/host stripped
});

test('find_full_text reports when nothing is open-access', function () {
    $user = $this->seedUser();
    $token = bibToken($user);
    $this->mock(UnpaywallService::class, fn ($m) => $m->shouldReceive('oaLocations')->andReturn([]));
    $this->mock(CoreService::class, fn ($m) => $m->shouldReceive('oaLocations')->andReturn([]));
    $this->mock(SemanticScholarService::class, fn ($m) => $m->shouldReceive('openAccessPdfByDoi')->andReturn(null));

    $json = bibJson(bibCall($this, $token, 'find_full_text', ['doi' => '10.1/paywalled']));
    expect($json['count'])->toBe(0);
    expect($json['note'])->toContain('paywalled');
});

test('bibliographic tools require the read ability', function () {
    $user = $this->seedUser();
    // A token with NO abilities.
    $token = $user->createToken('empty', ['annotate'], now()->addYear())->plainTextToken;

    $response = bibCall($this, $token, 'search_sources', ['query' => 'x']);
    // Ability-sized listing: hidden from the token, so tool-not-found.
    expect($response->json('error.code'))->toBe(-32602);
});
