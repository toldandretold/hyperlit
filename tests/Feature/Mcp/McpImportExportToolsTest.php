<?php

use App\Jobs\ProcessDocumentImportJob;
use App\Mcp\TokenAbilities;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/**
 * import_document / import_status / export_markdown over the real /mcp
 * endpoint. Queue::fake() asserts the import job is dispatched without running
 * it. Same harness rules as the other MCP suites.
 */

function ieToken(User $user, array $abilities): string
{
    return $user->createToken('mcp ie', $abilities, now()->addYear())->plainTextToken;
}

function ieCall($test, string $token, string $tool, array $arguments)
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => 'tools/call',
        'params' => ['name' => $tool, 'arguments' => $arguments],
    ], [
        'Authorization' => 'Bearer '.$token,
        'Accept' => 'application/json, text/event-stream',
    ]);
}

function ieJson($response): array
{
    return json_decode((string) ($response->json('result.content.0.text') ?? ''), true) ?: [];
}

test('import_document imports a markdown file and dispatches the import job', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);

    $response = ieCall($this, $token, 'import_document', [
        'title' => 'Imported via MCP',
        'file_base64' => base64_encode("# Imported via MCP\n\nFirst paragraph of the body.\n"),
        'filename' => 'note.md',
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    $json = ieJson($response);
    expect($json['status'] ?? null)->toBe('queued');
    expect($json['book'] ?? '')->toStartWith('book_');

    Queue::assertPushed(ProcessDocumentImportJob::class, 1);
});

test('import_document imports raw markdown content (the preferred path)', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);

    $response = ieCall($this, $token, 'import_document', [
        'title' => 'Pasted Article',
        'author' => 'J. Scholar',
        'content' => "# Pasted Article\n\nThe full text a model copied from a journal page.\n",
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    expect(ieJson($response)['status'] ?? null)->toBe('queued');
    Queue::assertPushed(ProcessDocumentImportJob::class, 1);
});

test('import_document requires a title when given content', function () {
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);

    $response = ieCall($this, $token, 'import_document', ['content' => '# Body only']);
    expect($response->json('result.isError'))->toBeTrue();
    expect((string) $response->json('result.content.0.text'))->toContain('title');
});

test('import_document rejects an oversized or non-base64 payload', function () {
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);

    $bad = ieCall($this, $token, 'import_document', [
        'title' => 'x', 'filename' => 'n.md', 'file_base64' => '!!!not base64!!!',
    ]);
    expect($bad->json('result.isError'))->toBeTrue();
});

test('a token without the import ability cannot import', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::READ]);

    $response = ieCall($this, $token, 'import_document', [
        'title' => 'x', 'filename' => 'n.md', 'file_base64' => base64_encode('# x'),
    ]);

    // Ability-sized listing: hidden from the token, so tool-not-found.
    expect($response->json('error.code'))->toBe(-32602);
    Queue::assertNothingPushed();
});

test('a PDF import returns an estimate and confirm_token, not an immediate import', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT, TokenAbilities::SPEND]);

    $response = ieCall($this, $token, 'import_document', [
        'title' => 'A PDF',
        'filename' => 'paper.pdf',
        'file_base64' => base64_encode("%PDF-1.4 not a real pdf body"),
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    $json = ieJson($response);
    expect($json['requires_confirmation'] ?? null)->toBeTrue();
    expect($json['confirm_token'] ?? '')->not->toBeEmpty();
    // Nothing imported yet.
    Queue::assertNothingPushed();
});

test('confirming a PDF import without the spend ability is refused', function () {
    Queue::fake();
    $user = $this->seedUser();

    // Estimate with a spend-capable token to get a confirm_token...
    $spendToken = ieToken($user, [TokenAbilities::IMPORT, TokenAbilities::SPEND]);
    $estimate = ieJson(ieCall($this, $spendToken, 'import_document', [
        'title' => 'A PDF', 'filename' => 'paper.pdf',
        'file_base64' => base64_encode('%PDF-1.4 body'),
    ]));
    $confirm = $estimate['confirm_token'];

    // ...then try to confirm with an import-only (no spend) token.
    $importOnly = ieToken($user, [TokenAbilities::IMPORT]);
    $response = ieCall($this, $importOnly, 'import_document', [
        'filename' => 'paper.pdf', 'file_base64' => base64_encode('%PDF-1.4 body'),
        'confirm_token' => $confirm,
    ]);

    expect($response->json('result.isError'))->toBeTrue();
    expect((string) $response->json('result.content.0.text'))->toContain("'spend' ability");
    Queue::assertNothingPushed();
});

test('an unknown confirm_token is rejected', function () {
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT, TokenAbilities::SPEND]);

    $response = ieCall($this, $token, 'import_document', [
        'filename' => 'paper.pdf', 'file_base64' => base64_encode('%PDF-1.4'),
        'confirm_token' => 'deadbeefdeadbeef',
    ]);

    expect($response->json('result.isError'))->toBeTrue();
    expect((string) $response->json('result.content.0.text'))->toContain('expired');
});

test('import_status reports not-found for an unknown book', function () {
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::READ]);

    $response = ieCall($this, $token, 'import_status', ['book' => 'book_does_not_exist_'.Str::random(5)]);
    expect($response->json('result.isError'))->toBeTrue();
});

test('import_status reads a real progress file (importProgress takes no Request)', function () {
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::READ]);
    $book = 'book_prog_'.Str::random(6);

    // Write a progress marker the way the import job would.
    $dir = resource_path("markdown/{$book}");
    \Illuminate\Support\Facades\File::ensureDirectoryExists($dir);
    \Illuminate\Support\Facades\File::put($dir.'/progress.json', json_encode([
        'status' => 'complete', 'percent' => 100, 'stage' => 'complete', 'detail' => 'Import complete',
    ]));

    try {
        $response = ieCall($this, $token, 'import_status', ['book' => $book]);
        expect($response->json('result.isError'))->not->toBeTrue();
        $json = ieJson($response);
        expect($json['status'])->toBe('complete');
        expect($json['percent'])->toBe(100);
    } finally {
        \Illuminate\Support\Facades\File::deleteDirectory($dir);
    }
});

// ── url: a DOI / OpenAlex id rides the open-access acquisition ladder ─────────

/** A normalised OpenAlex work, as OpenAlexService::fetchByDoi / fetchByOpenAlexId return it. */
function ieWork(bool $isOa = true): array
{
    $suffix = Str::lower(Str::random(8));

    return [
        'title' => 'IE Ladder Work '.$suffix,
        'author' => 'Tester, A.',
        'year' => 2021,
        'doi' => '10.5555/ie.'.$suffix,
        'openalex_id' => 'W8'.random_int(100000000, 999999999),
        'is_oa' => $isOa,
        'oa_status' => $isOa ? 'gold' : 'closed',
        'type' => 'article',
    ];
}

/** work_imports rows commit on pgsql_admin (outside RefreshDatabase) — clear this user's. */
function ieForgetWorkImports(User $user): void
{
    $db = DB::connection('pgsql_admin');
    foreach ($db->table('work_imports')->where('user_id', $user->id)->pluck('id') as $id) {
        \Illuminate\Support\Facades\File::deleteDirectory(resource_path("markdown/{$id}"));
    }
    $db->table('work_imports')->where('user_id', $user->id)->delete();
}

test('import_document with a DOI queues a single-work import on the MCP surface', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);
    $work = ieWork();
    $this->mock(\App\Services\OpenAlexService::class, fn ($m) => $m->shouldReceive('fetchByDoi')
        ->with($work['doi'])->andReturn($work));

    try {
        $response = ieCall($this, $token, 'import_document', ['url' => 'https://doi.org/'.$work['doi']]);

        expect($response->json('result.isError'))->not->toBeTrue();
        $json = ieJson($response);
        expect($json['status'])->toBe('queued');
        expect($json['import'] ?? '')->toStartWith('book_');
        Queue::assertPushedOn(ProcessDocumentImportJob::QUEUE_INTERACTIVE, \App\Jobs\ImportWorkJob::class);
        // The old importer's job is NOT what runs a DOI any more.
        Queue::assertNotPushed(ProcessDocumentImportJob::class);

        $row = DB::connection('pgsql_admin')->table('work_imports')->where('id', $json['import'])->first();
        expect($row)->surface->toBe('mcp')->user_id->toBe($user->id)->identifier->toBe('doi:'.$work['doi']);
    } finally {
        ieForgetWorkImports($user);
    }
});

test('import_document accepts an OpenAlex work id', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);
    $work = ieWork();
    $this->mock(\App\Services\OpenAlexService::class, fn ($m) => $m->shouldReceive('fetchByOpenAlexId')
        ->once()->with($work['openalex_id'])->andReturn($work));

    try {
        $response = ieCall($this, $token, 'import_document', ['url' => $work['openalex_id']]);

        expect($response->json('result.isError'))->not->toBeTrue();
        expect(ieJson($response)['status'])->toBe('queued');
        Queue::assertPushed(\App\Jobs\ImportWorkJob::class, 1);
    } finally {
        ieForgetWorkImports($user);
    }
});

test('import_document says an ordinary web page is not an identifier, instead of a bare error code', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);

    $response = ieCall($this, $token, 'import_document', ['url' => 'https://www.theguardian.com/some/article']);

    expect($response->json('result.isError'))->toBeTrue();
    $text = (string) $response->json('result.content.0.text');
    expect($text)->toContain('not a recognised work identifier')->toContain('content');
    Queue::assertNothingPushed();
});

test('a closed work with no open copy anywhere is refused with the reason and the source link', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);
    $work = ieWork(isOa: false);
    $this->mock(\App\Services\OpenAlexService::class, fn ($m) => $m->shouldReceive('fetchByDoi')->andReturn($work));
    $this->mock(\App\Services\SourceImport\Content\OaLocationResolver::class, fn ($m) => $m->shouldReceive('resolve')->andReturn([]));

    $response = ieCall($this, $token, 'import_document', ['url' => $work['doi']]);

    expect($response->json('result.isError'))->toBeTrue();
    $text = (string) $response->json('result.content.0.text');
    expect($text)->toContain('No open-access copy')->toContain('https://doi.org/'.$work['doi']);
    Queue::assertNothingPushed();
});

test('a closed work that has a repository copy is queued, not refused', function () {
    Queue::fake();
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::IMPORT]);
    $work = ieWork(isOa: false);
    $this->mock(\App\Services\OpenAlexService::class, fn ($m) => $m->shouldReceive('fetchByDoi')->andReturn($work));
    $this->mock(\App\Services\SourceImport\Content\OaLocationResolver::class, fn ($m) => $m->shouldReceive('resolve')->andReturn([
        ['url' => 'https://figshare.com/x.pdf', 'kind' => 'pdf', 'host' => 'figshare.com', 'host_class' => 'repository', 'source' => 'unpaywall'],
    ]));

    try {
        $response = ieCall($this, $token, 'import_document', ['url' => $work['doi']]);

        expect($response->json('result.isError'))->not->toBeTrue();
        Queue::assertPushed(\App\Jobs\ImportWorkJob::class, 1);
    } finally {
        ieForgetWorkImports($user);
    }
});

test('confirming a paused DOI import needs the spend ability, then re-queues it', function () {
    Queue::fake();
    $user = $this->seedUser(['status' => 'premium']);
    $id = 'book_ieconfirm_'.Str::lower(Str::random(6));
    $confirm = 'ieconfirm'.Str::lower(Str::random(10));
    DB::connection('pgsql_admin')->table('work_imports')->insert([
        'id' => $id, 'user_id' => $user->id, 'creator' => $user->name,
        'canonical_source_id' => (string) Str::uuid(), 'identifier' => 'doi:10.5555/ie.confirm',
        'surface' => 'mcp', 'status' => 'awaiting_confirmation', 'confirm_token' => $confirm,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        $noSpend = ieCall($this, ieToken($user, [TokenAbilities::IMPORT]), 'import_document', ['confirm_token' => $confirm]);
        expect($noSpend->json('result.isError'))->toBeTrue();
        expect((string) $noSpend->json('result.content.0.text'))->toContain('spend');
        Queue::assertNothingPushed();

        $ok = ieCall($this, ieToken($user, [TokenAbilities::IMPORT, TokenAbilities::SPEND]), 'import_document', ['confirm_token' => $confirm]);
        expect($ok->json('result.isError'))->not->toBeTrue();
        expect(ieJson($ok))->toMatchArray(['import' => $id, 'status' => 'queued']);
        Queue::assertPushedOn(ProcessDocumentImportJob::QUEUE_INTERACTIVE, \App\Jobs\ImportWorkJob::class);

        $row = DB::connection('pgsql_admin')->table('work_imports')->where('id', $id)->first();
        expect((bool) $row->ocr_confirmed)->toBeTrue()->and($row->confirm_token)->toBeNull();
    } finally {
        ieForgetWorkImports($user);
    }
});

test('import_status hands back the real book, the outcome and a pending OCR estimate', function () {
    $user = $this->seedUser();
    $token = ieToken($user, [TokenAbilities::READ]);
    $import = 'book_ieprog_'.Str::lower(Str::random(6));
    $dir = resource_path("markdown/{$import}");
    \Illuminate\Support\Facades\File::ensureDirectoryExists($dir);

    try {
        \App\Services\SourceImport\SingleWorkImporter::writeProgress($import, 'awaiting_confirmation', 'awaiting_confirmation', 40, 'needs OCR', [
            'estimated_pages' => 24, 'estimated_cost_usd' => 0.07, 'confirm_token' => 'tok123',
        ]);
        $paused = ieJson(ieCall($this, $token, 'import_status', ['book' => $import]));
        expect($paused)->toMatchArray([
            'status' => 'awaiting_confirmation', 'estimated_pages' => 24, 'estimated_cost_usd' => 0.07, 'confirm_token' => 'tok123',
        ]);

        \App\Services\SourceImport\SingleWorkImporter::writeProgress($import, 'complete', 'complete', 100, 'done', [
            'book' => 'the-real-book-uuid', 'outcome' => 'commons',
        ]);
        $done = ieJson(ieCall($this, $token, 'import_status', ['book' => $import]));
        expect($done)->toMatchArray(['status' => 'complete', 'book' => 'the-real-book-uuid', 'outcome' => 'commons']);
    } finally {
        \Illuminate\Support\Facades\File::deleteDirectory($dir);
    }
});

test('export_markdown returns the book body, paginated', function () {
    $user = $this->seedUser();
    $book = 'book_mcpx_'.Str::random(6);
    (function () use ($book, $user) {
        $this->seedLibrary([
            'book' => $book,
            'title' => 'Exportable',
            'author' => 'A. Author',
            'visibility' => 'public',
            'creator' => $user->name,
        ]);
        $this->seedNode([
            'book' => $book, 'startLine' => 100, 'chunk_id' => 0,
            'node_id' => $book.'_1_h', 'content' => '<h1 id="100" data-node-id="'.$book.'_1_h">Exportable</h1>',
            'plainText' => 'Exportable',
        ]);
        $this->seedNode([
            'book' => $book, 'startLine' => 200, 'chunk_id' => 0,
            'node_id' => $book.'_2_p', 'content' => '<p id="200" data-node-id="'.$book.'_2_p">The body of the exportable work.</p>',
            'plainText' => 'The body of the exportable work.',
        ]);
    })->call($this);

    $token = ieToken($user, [TokenAbilities::READ]);
    $response = ieCall($this, $token, 'export_markdown', ['book' => $book]);

    expect($response->json('result.isError'))->not->toBeTrue();
    $json = ieJson($response);
    expect($json['markdown'])->toContain('Exportable')->toContain('body of the exportable work');
    expect($json)->toHaveKey('total_chars');
    expect($json['next_offset'])->toBeNull();
});
