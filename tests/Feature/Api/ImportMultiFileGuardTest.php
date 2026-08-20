<?php

/**
 * POST /import-file multi-file guards.
 *
 * One import = ONE book. Historically a multi-file request with no .md
 * silently imported $files[0] and DISCARDED the rest (the "two PDFs → one
 * book, second thrown away" bug), and >1 .md silently took the first. Both
 * are now 422s — the batch importer splits multi-doc/vault drops client-side
 * into one request per book, so nothing legitimate sends these shapes.
 * The one-md-plus-images folder shape stays the valid one-book path.
 */

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Tests\Support\SeedsRlsFixtures;

uses(SeedsRlsFixtures::class);

beforeEach(function () {
    DB::connection('pgsql_admin')->table('library')->where('book', 'like', 'mfguard\_%')->delete();
    DB::connection('pgsql_admin')->table('users')->where('email', 'like', 'mfguard\_%@test.local')->delete();
});

afterEach(function () {
    DB::statement("SELECT set_config('app.current_user', '', false)");
    DB::statement("SELECT set_config('app.current_token', '', false)");
    foreach (glob(resource_path('markdown/mfguard_*')) ?: [] as $dir) {
        File::deleteDirectory($dir);
    }
});

function mfguardPost($test, array $files)
{
    return $test->post('/import-file', [
        'book' => 'mfguard_' . Str::random(10),
        'title' => 'Guard Test',
        'markdown_file' => $files,
    ], ['Accept' => 'application/json']);
}

test('multiple non-markdown documents in one request are rejected, not silently discarded', function () {
    Queue::fake();
    $this->actingAs($this->seedUser(['email' => 'mfguard_a@test.local']));

    $resp = mfguardPost($this, [
        UploadedFile::fake()->create('one.pdf', 10, 'application/pdf'),
        UploadedFile::fake()->create('two.pdf', 10, 'application/pdf'),
    ]);

    $resp->assertStatus(422);
    expect($resp->json('message'))->toContain('one per book');
    Queue::assertNothingPushed();
});

test('multiple markdown files in one request are rejected', function () {
    Queue::fake();
    $this->actingAs($this->seedUser(['email' => 'mfguard_b@test.local']));

    $resp = mfguardPost($this, [
        UploadedFile::fake()->createWithContent('a.md', "# A\n\nBody."),
        UploadedFile::fake()->createWithContent('b.md', "# B\n\nBody."),
    ]);

    $resp->assertStatus(422);
    expect($resp->json('message'))->toContain('One markdown file');
    Queue::assertNothingPushed();
});

test('one markdown file plus images stays the valid one-book folder path', function () {
    Queue::fake();
    $this->actingAs($this->seedUser(['email' => 'mfguard_c@test.local']));

    $resp = mfguardPost($this, [
        UploadedFile::fake()->createWithContent('main.md', "# Main\n\n![fig](fig.png)\n\nBody."),
        UploadedFile::fake()->image('fig.png'),
    ]);

    $resp->assertStatus(200);
    expect($resp->json('status'))->toBe('processing');
    Queue::assertPushed(\App\Jobs\ProcessDocumentImportJob::class, 1);
});
