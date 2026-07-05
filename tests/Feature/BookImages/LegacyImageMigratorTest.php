<?php

use App\Services\BookImageStore;
use App\Services\LegacyImageMigrator;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * LegacyImageMigrator::migrateBook — the per-book move used by BOTH the bulk
 * backfill command and the encrypt transition (docs/e2ee.md).
 */

function migBook(): string
{
    return 'legmig_'.Str::lower(Str::random(10));
}

function pngAt(string $path): void
{
    File::ensureDirectoryExists(dirname($path));
    File::put($path, base64_decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    ));
}

afterEach(function () {
    foreach (DB::connection('pgsql_admin')->table('book_images')->where('book', 'like', 'legmig_%')->pluck('book')->unique() as $b) {
        app(BookImageStore::class)->purgeBook($b);
        File::deleteDirectory(storage_path("app/public/books/{$b}"));
        File::deleteDirectory(resource_path("markdown/{$b}"));
    }
});

it('migrates a legacy EPUB (public) book: files → store, rows, src rewrite, legacy dir gone', function () {
    $book = migBook();
    $this->seedLibrary(['book' => $book, 'creator' => 'x', 'creator_token' => (string) Str::uuid()]);
    pngAt(storage_path("app/public/books/{$book}/images/fig.png"));
    $this->seedNode([
        'book' => $book, 'startLine' => 100,
        'content' => '<p><img src="/storage/books/'.$book.'/images/fig.png"></p>',
    ]);

    $result = app(LegacyImageMigrator::class)->migrateBook($book);

    expect($result['files'])->toBe(1)->and($result['rewritten_nodes'])->toBeGreaterThan(0);
    expect(File::exists(app(BookImageStore::class)->path($book, 'fig.png')))->toBeTrue();
    expect(File::isDirectory(storage_path("app/public/books/{$book}")))->toBeFalse();
    expect(DB::connection('pgsql_admin')->table('book_images')->where('book', $book)->count())->toBe(1);
    $content = DB::connection('pgsql_admin')->table('nodes')->where('book', $book)->where('startLine', 100)->value('content');
    expect($content)->toContain("/{$book}/media/fig.png")->not->toContain('/storage/books/');
});

it('migrates a legacy DOCX (media) book: files → store, srcs already canonical', function () {
    $book = migBook();
    $this->seedLibrary(['book' => $book, 'creator' => 'x', 'creator_token' => (string) Str::uuid()]);
    pngAt(resource_path("markdown/{$book}/media/pic.png"));

    $result = app(LegacyImageMigrator::class)->migrateBook($book);

    expect($result['files'])->toBe(1)->and($result['had_public_images'])->toBeFalse();
    expect(File::exists(app(BookImageStore::class)->path($book, 'pic.png')))->toBeTrue();
    expect(File::isDirectory(resource_path("markdown/{$book}/media")))->toBeFalse();
});

it('is a no-op for a book with no legacy files', function () {
    $book = migBook();
    $this->seedLibrary(['book' => $book, 'creator' => 'x', 'creator_token' => (string) Str::uuid()]);

    $result = app(LegacyImageMigrator::class)->migrateBook($book);
    expect($result)->toBe(['files' => 0, 'rewritten_nodes' => 0, 'had_public_images' => false]);
});
