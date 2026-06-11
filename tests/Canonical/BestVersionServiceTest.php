<?php

/**
 * BestVersionService — read-side resolution: precedence walk + per-caller
 * visibility + fallback to any visible linked version. Endpoint-contract
 * coverage lives in tests/Feature/Citations/CanonicalBestVersionTest.php;
 * this exercises the service directly, including pointer→pointer skipping
 * (an invisible higher authority falls through to the next pointer, not
 * straight to the linked-version fallback).
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\BestVersionService;
use Illuminate\Support\Facades\DB;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
    $this->service = new BestVersionService();
});

function canonvBest(string $canonicalId, ?object $user = null, ?string $anonToken = null): ?string
{
    // The service reads library via the default connection, which is RLS'd.
    // Mirror SetDatabaseSessionContext so the policies see the caller —
    // in production the middleware does this before the service runs.
    DB::statement("SELECT set_config('app.current_user', ?, false)", [$user->name ?? '']);
    DB::statement("SELECT set_config('app.current_token', ?, false)", [$user->user_token ?? $anonToken ?? '']);

    return app(BestVersionService::class)->bestVisibleVersion(
        CanonicalSource::find($canonicalId),
        $user,
        $anonToken,
    );
}

test('walks the full precedence order', function () {
    $author    = canonvSeedLibrary(['title' => 'CanonV Author Ed']);
    $publisher = canonvSeedLibrary(['title' => 'CanonV Publisher Ed']);
    $commons   = canonvSeedLibrary(['title' => 'CanonV Commons Ed']);
    $auto      = canonvSeedLibrary(['title' => 'CanonV Auto Ed']);

    $id = canonvSeedCanonical([
        'title'                  => 'CanonV Full Precedence',
        'author_version_book'    => $author,
        'publisher_version_book' => $publisher,
        'commons_version_book'   => $commons,
        'auto_version_book'      => $auto,
    ]);

    expect(canonvBest($id))->toBe($author);

    // Knock out the winner each round; the next authority takes over.
    canonvDb()->table('canonical_source')->where('id', $id)->update(['author_version_book' => null]);
    expect(canonvBest($id))->toBe($publisher);

    canonvDb()->table('canonical_source')->where('id', $id)->update(['publisher_version_book' => null]);
    expect(canonvBest($id))->toBe($commons);

    canonvDb()->table('canonical_source')->where('id', $id)->update(['commons_version_book' => null]);
    expect(canonvBest($id))->toBe($auto);
});

test('an invisible higher authority falls through to the NEXT pointer, not the fallback', function () {
    $owner = canonvSeedUser('canonv_owner');
    $privateAuthor = canonvSeedLibrary([
        'title'      => 'CanonV Private Author Ed',
        'creator'    => $owner->name,
        'visibility' => 'private',
        'listed'     => false,
    ]);
    $publicAuto = canonvSeedLibrary(['title' => 'CanonV Public Auto Ed']);

    $id = canonvSeedCanonical([
        'title'               => 'CanonV Skip To Next',
        'author_version_book' => $privateAuthor,
        'auto_version_book'   => $publicAuto,
    ]);

    // Anonymous caller: skips the private author edition, lands on auto.
    expect(canonvBest($id))->toBe($publicAuto);

    // The owner still gets their private author edition.
    expect(canonvBest($id, $owner))->toBe($privateAuthor);
});

test('public UNLISTED versions are resolvable (auto stubs are created public+unlisted)', function () {
    // `listed` only governs homepage listings — requiring it here would make
    // every auto version invisible to anonymous callers (regression: all
    // library:create-auto-versions output is public + listed=false).
    $autoStub = canonvSeedLibrary([
        'title'  => 'CanonV Unlisted Auto Ed',
        'listed' => false,
    ]);
    $id = canonvSeedCanonical([
        'title'             => 'CanonV Unlisted Pointer',
        'auto_version_book' => $autoStub,
    ]);
    expect(canonvBest($id))->toBe($autoStub);

    // Same rule on the fallback path (linked but no pointer).
    $id2 = canonvSeedCanonical(['title' => 'CanonV Unlisted Fallback']);
    $linked = canonvSeedLibrary([
        'title'               => 'CanonV Unlisted Linked',
        'listed'              => false,
        'canonical_source_id' => $id2,
    ]);
    expect(canonvBest($id2))->toBe($linked);
});

test('falls back to any visible linked version when no pointer resolves', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Fallback']);
    $linked = canonvSeedLibrary([
        'title'               => 'CanonV Linked Only',
        'canonical_source_id' => $id,
    ]);

    expect(canonvBest($id))->toBe($linked);
});

test('returns null for a citation-only canonical (no versions at all)', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Citation Only']);

    expect(canonvBest($id))->toBeNull();
});

test('bestPublicContentVersion prefers pointers with content, skips contentless and private ones', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Content Resolution']);

    $contentlessAuthor = canonvSeedLibrary(['title' => 'CanonV Author NoNodes', 'has_nodes' => false]);
    $privateCommons    = canonvSeedLibrary(['title' => 'CanonV Commons Private', 'visibility' => 'private', 'has_nodes' => true]);
    $publicAuto        = canonvSeedLibrary(['title' => 'CanonV Auto Content', 'has_nodes' => true, 'listed' => false]);

    canonvDb()->table('canonical_source')->where('id', $id)->update([
        'author_version_book'  => $contentlessAuthor,
        'commons_version_book' => $privateCommons,
        'auto_version_book'    => $publicAuto,
    ]);

    $best = app(BestVersionService::class)->bestPublicContentVersion(CanonicalSource::find($id));

    expect($best['book'])->toBe($publicAuto);
    expect($best['pointer'])->toBe('auto_version_book');
});

test('bestPublicContentVersion falls back to any public linked version, else null', function () {
    $id = canonvSeedCanonical(['title' => 'CanonV Content Fallback']);
    $linked = canonvSeedLibrary([
        'title'               => 'CanonV Linked Content',
        'canonical_source_id' => $id,
        'has_nodes'           => true,
    ]);

    $best = app(BestVersionService::class)->bestPublicContentVersion(CanonicalSource::find($id));
    expect($best['book'])->toBe($linked);
    expect($best['pointer'])->toBeNull();

    $empty = canonvSeedCanonical(['title' => 'CanonV Content None']);
    expect(app(BestVersionService::class)->bestPublicContentVersion(CanonicalSource::find($empty)))->toBeNull();
});

test('never leaks another user\'s private fallback version', function () {
    $owner = canonvSeedUser('canonv_private_owner');
    $id = canonvSeedCanonical(['title' => 'CanonV Private Fallback']);
    canonvSeedLibrary([
        'title'               => 'CanonV Private Linked',
        'canonical_source_id' => $id,
        'creator'             => $owner->name,
        'visibility'          => 'private',
        'listed'              => false,
    ]);

    $stranger = canonvSeedUser('canonv_stranger');
    expect(canonvBest($id))->toBeNull();
    expect(canonvBest($id, $stranger))->toBeNull();
    expect(canonvBest($id, $owner))->not->toBeNull();
});
