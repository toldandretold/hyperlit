<?php

use App\Services\BookImageStore;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

/**
 * BookImageStore (docs/e2ee.md): the write seam that moves conversion images
 * into the private store + upserts rows. Rows go through pgsql_admin (trusted
 * server-side seam / queue workers have no RLS session), so assert on it.
 */

/** Write a real 1x1 PNG so getimagesize() reports dims. */
function tinyPng(string $path): void
{
    File::ensureDirectoryExists(dirname($path));
    // 1x1 transparent PNG
    File::put($path, base64_decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    ));
}

function imageRows(string $book)
{
    return DB::connection('pgsql_admin')->table('book_images')->where('book', $book)->get();
}

beforeEach(function () {
    $this->store = app(BookImageStore::class);
    $this->handoff = storage_path('framework/testing/handoff_'.uniqid());
    File::ensureDirectoryExists($this->handoff);
});

afterEach(function () {
    File::deleteDirectory($this->handoff);
    if (isset($this->testBook)) {
        $this->store->purgeBook($this->testBook);
    }
});

it('moves images into the private store and upserts rows with dims + mime', function () {
    $this->testBook = 'store_a';
    tinyPng("{$this->handoff}/fig1.png");
    tinyPng("{$this->handoff}/fig2.png");
    File::put("{$this->handoff}/notes.txt", 'ignore me'); // non-image, skipped

    $count = $this->store->ingestFromDirectory('store_a', $this->handoff);
    expect($count)->toBe(2);

    // Files moved OUT of the handoff dir, INTO the store
    expect(File::exists("{$this->handoff}/fig1.png"))->toBeFalse();
    expect(File::exists($this->store->path('store_a', 'fig1.png')))->toBeTrue();

    $rows = imageRows('store_a');
    expect($rows)->toHaveCount(2);
    $fig1 = $rows->firstWhere('filename', 'fig1.png');
    expect($fig1->mime)->toBe('image/png')
        ->and($fig1->width)->toBe(1)
        ->and($fig1->height)->toBe(1)
        ->and((bool) $fig1->encrypted)->toBeFalse()
        ->and($fig1->bytes)->toBeGreaterThan(0);
});

it('prune=true makes the store mirror the latest conversion (removes stale)', function () {
    $this->testBook = 'store_prune';
    tinyPng("{$this->handoff}/old1.png");
    tinyPng("{$this->handoff}/keep.png");
    $this->store->ingestFromDirectory('store_prune', $this->handoff);
    expect(imageRows('store_prune'))->toHaveCount(2);

    // Second conversion only produces keep.png + new.png
    File::ensureDirectoryExists($this->handoff);
    tinyPng("{$this->handoff}/keep.png");
    tinyPng("{$this->handoff}/new.png");
    $this->store->ingestFromDirectory('store_prune', $this->handoff, prune: true);

    $names = imageRows('store_prune')->pluck('filename')->sort()->values()->all();
    expect($names)->toBe(['keep.png', 'new.png']); // old1.png pruned
    expect(File::exists($this->store->path('store_prune', 'old1.png')))->toBeFalse();
});

it('purgeBook deletes rows and files', function () {
    $this->testBook = 'store_purge';
    tinyPng("{$this->handoff}/x.png");
    $this->store->ingestFromDirectory('store_purge', $this->handoff);
    expect(imageRows('store_purge'))->toHaveCount(1);

    $this->store->purgeBook('store_purge');
    expect(imageRows('store_purge'))->toHaveCount(0);
    expect(File::isDirectory($this->store->dir('store_purge')))->toBeFalse();
});

it('replaceBytes swaps the file in place and flips the encrypted flag', function () {
    $this->testBook = 'store_replace';
    tinyPng("{$this->handoff}/img.png");
    $this->store->ingestFromDirectory('store_replace', $this->handoff);

    // "Encrypt" it: replace bytes with a ciphertext blob, flag encrypted
    $cipher = storage_path('framework/testing/cipher_'.uniqid().'.bin');
    File::put($cipher, 'HLENC1'.str_repeat("\x00", 40));
    $this->store->replaceBytes('store_replace', 'img.png', $cipher, encrypted: true);
    File::delete($cipher);

    $row = imageRows('store_replace')->firstWhere('filename', 'img.png');
    expect((bool) $row->encrypted)->toBeTrue();
    expect(File::get($this->store->path('store_replace', 'img.png')))->toStartWith('HLENC1');
});

it('rejects a traversal filename', function () {
    expect(fn () => $this->store->path('store_x', '../secret'))
        ->toThrow(\InvalidArgumentException::class);
});
