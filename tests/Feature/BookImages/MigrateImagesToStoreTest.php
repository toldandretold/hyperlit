<?php

use App\Services\BookImageStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * images:migrate-to-store backfill (docs/e2ee.md): moves both legacy image
 * locations into the private store + rewrites the old public /storage/books/
 * srcs. Dry-run touches nothing.
 */

function tinyPngAt(string $path): void
{
    File::ensureDirectoryExists(dirname($path));
    File::put($path, base64_decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    ));
}

afterEach(function () {
    foreach (['mig_epub', 'mig_docx'] as $b) {
        app(BookImageStore::class)->purgeBook($b);
        File::deleteDirectory(storage_path("app/public/books/{$b}"));
        File::deleteDirectory(resource_path("markdown/{$b}"));
    }
});

it('migrates a legacy EPUB (public storage) book: moves files, rows, rewrites srcs', function () {
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => 'mig_epub', 'creator' => $owner->name, 'creator_token' => $owner->user_token]);
    // legacy-A file + a node referencing the old public URL
    tinyPngAt(storage_path('app/public/books/mig_epub/images/fig.png'));
    $this->seedNode([
        'book' => 'mig_epub', 'startLine' => 100,
        'content' => '<p><img src="/storage/books/mig_epub/images/fig.png"></p>',
    ]);

    $this->artisan('images:migrate-to-store', ['book' => 'mig_epub'])->assertSuccessful();

    // File moved into the private store; public dir gone
    expect(File::exists(app(BookImageStore::class)->path('mig_epub', 'fig.png')))->toBeTrue();
    expect(File::isDirectory(storage_path('app/public/books/mig_epub')))->toBeFalse();
    // Row registered
    expect(DB::connection('pgsql_admin')->table('book_images')->where('book', 'mig_epub')->count())->toBe(1);
    // Content src rewritten to the canonical route
    $content = DB::connection('pgsql_admin')->table('nodes')
        ->where('book', 'mig_epub')->where('startLine', 100)->value('content');
    expect($content)->toContain('/mig_epub/media/fig.png')
        ->not->toContain('/storage/books/');
});

it('migrates a legacy DOCX (markdown/media) book: files + rows, srcs already canonical', function () {
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => 'mig_docx', 'creator' => $owner->name, 'creator_token' => $owner->user_token]);
    tinyPngAt(resource_path('markdown/mig_docx/media/pic.png'));
    $this->seedNode([
        'book' => 'mig_docx', 'startLine' => 100,
        'content' => '<p><img src="/mig_docx/media/pic.png"></p>',
    ]);

    $this->artisan('images:migrate-to-store', ['book' => 'mig_docx'])->assertSuccessful();

    expect(File::exists(app(BookImageStore::class)->path('mig_docx', 'pic.png')))->toBeTrue();
    expect(DB::connection('pgsql_admin')->table('book_images')->where('book', 'mig_docx')->count())->toBe(1);
    // src unchanged (already the canonical media route)
    $content = DB::connection('pgsql_admin')->table('nodes')
        ->where('book', 'mig_docx')->where('startLine', 100)->value('content');
    expect($content)->toContain('/mig_docx/media/pic.png');
});

it('dry-run touches nothing', function () {
    $owner = $this->seedUser();
    $this->seedLibrary(['book' => 'mig_epub', 'creator' => $owner->name, 'creator_token' => $owner->user_token]);
    tinyPngAt(storage_path('app/public/books/mig_epub/images/fig.png'));
    $this->seedNode([
        'book' => 'mig_epub', 'startLine' => 100,
        'content' => '<p><img src="/storage/books/mig_epub/images/fig.png"></p>',
    ]);

    $this->artisan('images:migrate-to-store', ['book' => 'mig_epub', '--dry-run' => true])->assertSuccessful();

    // Nothing moved, no rows, no rewrite
    expect(File::exists(storage_path('app/public/books/mig_epub/images/fig.png')))->toBeTrue();
    expect(DB::connection('pgsql_admin')->table('book_images')->where('book', 'mig_epub')->count())->toBe(0);
    $content = DB::connection('pgsql_admin')->table('nodes')
        ->where('book', 'mig_epub')->where('startLine', 100)->value('content');
    expect($content)->toContain('/storage/books/mig_epub/images/');
});
