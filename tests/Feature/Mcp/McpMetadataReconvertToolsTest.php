<?php

use App\Mcp\TokenAbilities;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/**
 * reconvert_book, set_book_metadata, lookup_citation_metadata, and the
 * import dedup check — over the real /mcp endpoint. Same harness rules.
 */

function mrToken(User $user, array $abilities): string
{
    return $user->createToken('mcp mr', $abilities, now()->addYear())->plainTextToken;
}

function mrCall($test, string $token, string $tool, array $arguments)
{
    app('auth')->forgetGuards();

    return $test->postJson('/mcp', [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call',
        'params' => ['name' => $tool, 'arguments' => $arguments],
    ], ['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json, text/event-stream']);
}

function mrJson($response): array
{
    return json_decode((string) ($response->json('result.content.0.text') ?? ''), true) ?: [];
}

function mrSeedBook($test, User $owner, string $title = 'An Existing Work'): string
{
    $book = 'book_mcpmr_'.Str::random(6);
    (function () use ($book, $owner, $title) {
        $this->seedLibrary(['book' => $book, 'title' => $title, 'visibility' => 'public', 'creator' => $owner->name]);
    })->call($test);

    return $book;
}

test('set_book_metadata writes the citation fields (owner only)', function () {
    $owner = $this->seedUser();
    $book = mrSeedBook($this, $owner);
    $token = mrToken($owner, [TokenAbilities::IMPORT]);

    $response = mrCall($this, $token, 'set_book_metadata', [
        'book' => $book,
        'title' => 'Undersea cables in Africa',
        'author' => 'Esther Mwema; Abeba Birhane',
        'year' => '2024',
        'journal' => 'First Monday',
        'volume' => '29', 'issue' => '4',
        'doi' => '10.5210/fm.v29i4.13637',
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    expect(mrJson($response)['updated_fields'])->toContain('title', 'author', 'journal');

    DB::statement("select set_config('app.current_user', ?, false)", [$owner->name]);
    $row = DB::table('library')->where('book', $book)->first();
    expect($row->title)->toBe('Undersea cables in Africa');
    expect($row->journal)->toBe('First Monday');
    expect($row->url)->toBe('https://doi.org/10.5210/fm.v29i4.13637');
});

test('set_book_metadata bumps library.timestamp so cached clients refresh', function () {
    // library.timestamp is the freshness signal clients compare against their
    // IndexedDB copy. An MCP metadata write that leaves it alone lands in Postgres
    // but every browser that has the book cached keeps the old card (prod
    // 2026-11-07: /terms retitled via MCP, only a private window saw it).
    $owner = $this->seedUser();
    $book = mrSeedBook($this, $owner);
    $token = mrToken($owner, [TokenAbilities::IMPORT]);

    DB::statement("select set_config('app.current_user', ?, false)", [$owner->name]);
    $before = (int) DB::table('library')->where('book', $book)->value('timestamp');

    $response = mrCall($this, $token, 'set_book_metadata', ['book' => $book, 'title' => 'Terms of Service']);
    expect($response->json('result.isError'))->not->toBeTrue();

    DB::statement("select set_config('app.current_user', ?, false)", [$owner->name]);
    $after = (int) DB::table('library')->where('book', $book)->value('timestamp');
    expect($after)->toBeGreaterThan($before);
});

test('set_book_metadata refuses a non-owner', function () {
    $owner = $this->seedUser();
    $book = mrSeedBook($this, $owner);
    $stranger = $this->seedUser();
    $token = mrToken($stranger, [TokenAbilities::IMPORT]);

    $response = mrCall($this, $token, 'set_book_metadata', ['book' => $book, 'title' => 'Hijacked']);
    expect($response->json('result.isError'))->toBeTrue();

    DB::statement("select set_config('app.current_user', ?, false)", [$owner->name]);
    expect(DB::table('library')->where('book', $book)->value('title'))->not->toBe('Hijacked');
});

test('set_book_metadata needs at least one field', function () {
    $owner = $this->seedUser();
    $book = mrSeedBook($this, $owner);
    $token = mrToken($owner, [TokenAbilities::IMPORT]);

    $response = mrCall($this, $token, 'set_book_metadata', ['book' => $book]);
    expect($response->json('result.isError'))->toBeTrue();
    expect((string) $response->json('result.content.0.text'))->toContain('at least one');
});

test('import_document dedup returns an existing book of the same title', function () {
    Queue::fake();
    $owner = $this->seedUser();
    // Unique title: the shared test DB carries residue of common titles.
    $title = 'Networks of Commoning '.Str::random(8);
    $book = mrSeedBook($this, $owner, $title);
    $token = mrToken($owner, [TokenAbilities::IMPORT]);

    $response = mrCall($this, $token, 'import_document', [
        'title' => $title,
        'content' => "# {$title}\n\nBody.",
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    $json = mrJson($response);
    expect($json['already_exists'] ?? null)->toBeTrue();
    expect($json['match']['book'])->toBe($book);
    Queue::assertNothingPushed();
});

test('import_document force:true imports despite a duplicate title', function () {
    Queue::fake();
    $owner = $this->seedUser();
    $title = 'Networks of Commoning '.Str::random(8);
    mrSeedBook($this, $owner, $title);
    $token = mrToken($owner, [TokenAbilities::IMPORT]);

    $response = mrCall($this, $token, 'import_document', [
        'title' => $title,
        'content' => "# {$title}\n\nBody.",
        'force' => true,
    ]);

    expect($response->json('result.isError'))->not->toBeTrue();
    expect(mrJson($response)['status'] ?? null)->toBe('queued');
    Queue::assertPushed(\App\Jobs\ProcessDocumentImportJob::class, 1);
});

test('reconvert_book re-runs an existing book from its cached source', function () {
    Queue::fake();
    $owner = $this->seedUser();
    $book = mrSeedBook($this, $owner);
    // A cached source must exist for reconvert.
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put($dir.'/original.md', "# An Existing Work\n\nBody text.\n");
    $token = mrToken($owner, [TokenAbilities::IMPORT]);

    try {
        $response = mrCall($this, $token, 'reconvert_book', ['book' => $book]);
        expect($response->json('result.isError'))->not->toBeTrue();
        $json = mrJson($response);
        expect($json['book'])->toBe($book);
        expect($json['replaced_source'])->toBeFalse();
        Queue::assertPushed(\App\Jobs\ProcessDocumentImportJob::class, 1);
    } finally {
        File::deleteDirectory($dir);
    }
});

test('reconvert_book refuses a non-owner', function () {
    Queue::fake();
    $owner = $this->seedUser();
    $book = mrSeedBook($this, $owner);
    $dir = resource_path("markdown/{$book}");
    File::ensureDirectoryExists($dir);
    File::put($dir.'/original.md', "# x\n");
    $stranger = $this->seedUser();
    $token = mrToken($stranger, [TokenAbilities::IMPORT]);

    try {
        $response = mrCall($this, $token, 'reconvert_book', ['book' => $book]);
        expect($response->json('result.isError'))->toBeTrue();
        Queue::assertNothingPushed();
    } finally {
        File::deleteDirectory($dir);
    }
});
