<?php

/**
 * Remaining import + citation read/queue endpoints.
 *   - UrlImportController inspect/commit (arXiv/DOI) — hit OpenAlex on the happy
 *     path, so only validation is tested.
 *   - ImportController::reconvertInfo — filesystem-only, safe to call.
 *   - CitationScannerController history/running/resume — pgsql_admin reads, safe.
 *   - SearchController::searchNodes — public full-text, short-query branch.
 */

use Illuminate\Support\Str;

afterEach(fn () => $this->cleanupApiFixtures());

/* ─── url import (author) ─────────────────────────────────────────── */

test('POST /import-url/inspect requires an author', function () {
    $this->assertApiError($this->postJson('/import-url/inspect', ['url' => 'https://arxiv.org/abs/1234']), 401);
});

test('POST /import-url/inspect 422s without a url (before the API call)', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/import-url/inspect', []), 422);
});

test('POST /import-url 422s without url + book', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/import-url', []), 422);
});

/* ─── url import: the DOI / OpenAlex ladder lane ──────────────────── */

function iucWork(bool $isOa): array
{
    $suffix = Str::lower(Str::random(8));

    return [
        'title' => 'IUC Ladder Work ' . $suffix, 'author' => 'Tester, A.', 'year' => 2021,
        'doi' => '10.5555/iuc.' . $suffix, 'openalex_id' => 'W7' . random_int(100000000, 999999999),
        'is_oa' => $isOa, 'oa_status' => $isOa ? 'gold' : 'closed', 'type' => 'article',
    ];
}

test('inspect calls a closed work fetchable when a free copy is listed elsewhere', function () {
    $this->loginUser();
    $work = iucWork(isOa: false);
    $this->mock(\App\Services\OpenAlexService::class, fn ($m) => $m->shouldReceive('fetchByDoi')->andReturn($work));
    $this->mock(\App\Services\SourceImport\Content\OaLocationResolver::class, fn ($m) => $m->shouldReceive('resolve')->andReturn([
        ['url' => 'https://figshare.com/x.pdf', 'kind' => 'pdf', 'host' => 'figshare.com', 'host_class' => 'repository', 'source' => 'unpaywall'],
    ]));

    $this->postJson('/import-url/inspect', ['url' => $work['doi']])
        ->assertOk()
        ->assertJsonPath('plan.access', 'closed')
        ->assertJsonPath('plan.fetchable', true)
        ->assertJsonPath('plan.open_copies', 1)
        ->assertJsonPath('plan.via_ladder', true);
});

test('inspect leaves a closed work with no free copy unfetchable', function () {
    $this->loginUser();
    $work = iucWork(isOa: false);
    $this->mock(\App\Services\OpenAlexService::class, fn ($m) => $m->shouldReceive('fetchByDoi')->andReturn($work));
    $this->mock(\App\Services\SourceImport\Content\OaLocationResolver::class, fn ($m) => $m->shouldReceive('resolve')->andReturn([]));

    $this->postJson('/import-url/inspect', ['url' => $work['doi']])
        ->assertOk()
        ->assertJsonPath('plan.fetchable', false);
});

test('committing a DOI queues the ladder job and answers at once, on the web surface', function () {
    \Illuminate\Support\Facades\Queue::fake();
    $user = $this->loginUser();
    $work = iucWork(isOa: true);
    $this->mock(\App\Services\OpenAlexService::class, fn ($m) => $m->shouldReceive('fetchByDoi')->andReturn($work));
    $slug = 'iuc-' . Str::lower(Str::random(8));
    $admin = \Illuminate\Support\Facades\DB::connection('pgsql_admin');

    try {
        $this->postJson('/import-url', ['url' => 'https://doi.org/' . $work['doi'], 'book' => $slug])
            ->assertOk()
            ->assertJson(['ok' => true, 'bookId' => $slug, 'import' => $slug, 'async' => true]);

        \Illuminate\Support\Facades\Queue::assertPushedOn(
            \App\Jobs\ProcessDocumentImportJob::QUEUE_INTERACTIVE,
            \App\Jobs\ImportWorkJob::class,
        );
        // No user-owned library row is minted up front any more — the job decides what lands.
        expect($admin->table('library')->where('book', $slug)->exists())->toBeFalse();
        expect($admin->table('work_imports')->where('id', $slug)->first())
            ->surface->toBe('web')->user_id->toBe($user->id);
        // The poll the form already uses sees it immediately.
        $this->getJson("/api/import-progress/{$slug}")->assertOk()->assertJsonPath('status', 'queued');
    } finally {
        $admin->table('work_imports')->where('id', $slug)->delete();
        \Illuminate\Support\Facades\File::deleteDirectory(resource_path("markdown/{$slug}"));
    }
});

/* ─── reconvert-info (author, filesystem-only) ────────────────────── */

test('GET /api/books/{book}/reconvert-info requires an author', function () {
    $this->assertApiError($this->getJson('/api/books/apitest_x/reconvert-info'), 401);
});

test('GET /api/books/{book}/reconvert-info reports not-reconvertible for an unknown book', function () {
    $this->loginUser();
    $this->getJson('/api/books/apitest_unknown/reconvert-info')
        ->assertStatus(200)
        ->assertJson(['canReconvert' => false, 'sourceType' => null]);
});

/* ─── citation reads (auth:sanctum) ───────────────────────────────── */

test('GET /api/citation-scanner/history/{book} requires authentication', function () {
    $this->assertApiError($this->getJson('/api/citation-scanner/history/apitest_x'), 401);
});

test('GET /api/citation-scanner/history/{book} returns an empty list for an unknown book', function () {
    $this->loginUser();
    $this->getJson('/api/citation-scanner/history/apitest_unknown')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'scans' => []]);
});

test('GET /api/citation-pipeline/running/{book} returns no active pipeline for an unknown book', function () {
    $this->loginUser();
    $this->getJson('/api/citation-pipeline/running/apitest_unknown')
        ->assertStatus(200)
        ->assertJson(['success' => true, 'pipeline' => null]);
});

test('POST /api/citation-pipeline/resume/{id} 404s for an unknown pipeline', function () {
    $this->loginUser();
    $this->assertApiError($this->postJson('/api/citation-pipeline/resume/' . Str::uuid()), 404);
});

/* ─── search nodes (public, full-text) ────────────────────────────── */

test('GET /api/search/nodes returns the full-text envelope for a short query', function () {
    $this->getJson('/api/search/nodes?q=a')
        ->assertStatus(200)
        ->assertJsonStructure(['success', 'results', 'query', 'mode'])
        ->assertJson(['success' => true, 'results' => []]);
});
