<?php

/**
 * The in-flight-write race, and the guard that stops it.
 *
 * Production evidence (book_1784101513217): the library row was marked
 * `deleted` at 07:45:41 and 15,391 nodes landed at 07:45:43, from an import
 * that had been running for 28 seconds. The content then sat there permanently,
 * invisible to every cleanup — the orphan sweep looks for a MISSING library
 * row, and a deleted book still has one.
 *
 * The thrown MESSAGE is tested as carefully as the behaviour, because it is the
 * only record of the circumstances: it is what an operator reads on
 * /maintainer/jobs and what lands in the case bundle's exception.txt. The
 * delete happens in a different request, and its own log line may not exist.
 */

use App\Services\Books\DeletedBookGuard;
use Illuminate\Support\Facades\DB;

afterEach(function () {
    DB::connection('pgsql_admin')->table('library')->where('book', 'like', 'guardtest%')->delete();
});

function seedBook(string $book, string $visibility, array $extra = []): void
{
    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book,
        'title' => 'Guard test',
        'creator' => null,
        'creator_token' => '11111111-1111-1111-1111-111111111111',
        'visibility' => $visibility,
        'timestamp' => now()->timestamp,
        'raw_json' => json_encode([]),
        'created_at' => now()->subSeconds(28),
        'updated_at' => now(),
    ], $extra));
}

test('a live book is writable', function () {
    seedBook('guardtest_live', 'private');

    DeletedBookGuard::assertWritable('guardtest_live');
    expect(DeletedBookGuard::isDeleted('guardtest_live'))->toBeFalse();
});

test('a deleted book refuses writes', function () {
    seedBook('guardtest_gone', 'deleted');

    expect(DeletedBookGuard::isDeleted('guardtest_gone'))->toBeTrue();
    expect(fn () => DeletedBookGuard::assertWritable('guardtest_gone'))
        ->toThrow(RuntimeException::class);
});

test('the failure message carries everything needed to understand the incident', function () {
    seedBook('guardtest_ctx', 'deleted');

    try {
        DeletedBookGuard::assertWritable('guardtest_ctx', null, ['nodes_pending' => 15391]);
        $this->fail('guard did not throw');
    } catch (RuntimeException $e) {
        $m = $e->getMessage();

        expect($m)->toContain('guardtest_ctx')            // which book
            ->toContain('15391')                           // how much content was about to be written
            ->toContain('anonymous session')               // who owned it
            ->toContain('28s')                             // how long it lived before deletion
            ->toContain('DELETE /api/books')               // where deletes come from
            ->toContain('orphan sweep');                   // why it would have been invisible
    }
});

test('sub-books are exempt — their content is preserved on purpose', function () {
    // BookDeletionService keeps `metadata_only` descendants so highlights
    // pointing into footnote sub-books survive the parent's deletion. On
    // production that is 497 sub-books holding 513 nodes, all intentional.
    seedBook('guardtest_parent', 'deleted');
    seedBook('guardtest_parent/Fn123', 'deleted');

    expect(DeletedBookGuard::isDeleted('guardtest_parent/Fn123'))->toBeFalse();
    DeletedBookGuard::assertWritable('guardtest_parent/Fn123');
});

test('an unknown book is writable — absence is not deletion', function () {
    // A book mid-creation has no library row yet. Refusing here would break
    // every fresh import.
    expect(DeletedBookGuard::isDeleted('guardtest_never_existed'))->toBeFalse();
});
