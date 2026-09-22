<?php

/**
 * Publish gate (config/publishing.php + DbLibraryController).
 *
 * Making a book public — visibility→public / listed→true — requires a verified
 * email for accounts created at/after a cutoff, and is never allowed for
 * anonymous authors. The gate CLAMPS rather than 422s: it keeps the book
 * private and reports `publish_denied` in the 200 response, because this
 * endpoint carries a bulk library sync and hard-failing it over one field would
 * wedge the save queue. Accounts created BEFORE the cutoff are grandfathered
 * (verification was never historically enforced, so they are not stranded).
 *
 * Each test pins the cutoff explicitly so the outcome never depends on the
 * wall-clock date. Books are seeded via 'app' (RLS-scoped, rolled back) because
 * the upsert mutates them through the default connection.
 */

use Illuminate\Support\Str;
use Tests\Feature\Api\Support\InteractsWithApi;

// The RLS-aware user/book helpers (loginUser, makeBook, anonSession, cleanup)
// live in InteractsWithApi, which Pest binds only to Feature/Api. This gate is
// filed under Security but needs the same seam — bind it for this file.
uses(InteractsWithApi::class);

afterEach(fn () => $this->cleanupApiFixtures());

/** POST a visibility=public upsert for an owned book; return the decoded JSON. */
function publishAttempt($test, string $book): array
{
    return $test->postJson('/api/db/library/upsert', ['data' => [
        'book' => $book,
        'title' => 'Publish Gate Test',
        'visibility' => 'public',
        'timestamp' => 2000,
    ]])->assertStatus(200)->json();
}

test('a verified, post-cutoff account CAN publish', function () {
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    $owner = $this->loginUser(['email_verified_at' => now(), 'created_at' => now()]);
    $book = $this->makeBook($owner, ['via' => 'app']);

    $json = publishAttempt($this, $book);

    expect($json['publish_denied'])->toBeNull()
        ->and($json['library']['visibility'])->toBe('public');
});

test('an unverified, post-cutoff account is CLAMPED to private with reason', function () {
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    $owner = $this->loginUser(['email_verified_at' => null, 'created_at' => now()]);
    $book = $this->makeBook($owner, ['via' => 'app']);

    $json = publishAttempt($this, $book);

    expect($json['publish_denied'])->toBe('unverified_email')
        ->and($json['library']['visibility'])->toBe('private');
});

test('an unverified account created BEFORE the cutoff is grandfathered', function () {
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    // created two days ago = before the cutoff
    $owner = $this->loginUser(['email_verified_at' => null, 'created_at' => now()->subDays(2)]);
    $book = $this->makeBook($owner, ['via' => 'app']);

    $json = publishAttempt($this, $book);

    expect($json['publish_denied'])->toBeNull()
        ->and($json['library']['visibility'])->toBe('public');
});

test('an anonymous author can never publish', function () {
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    $token = $this->anonSession()['token'];
    $book = $this->makeBook($token); // anon-owned via creator_token

    // JSON requests strip the cookie jar unless withCredentials() is set — same
    // ceremony as the anon assertions in NotificationTriggerTest / SubBookVisibilityApiTest.
    $json = $this->withCredentials()->withUnencryptedCookie('anon_token', $token)
        ->postJson('/api/db/library/upsert', ['data' => [
            'book' => $book,
            'title' => 'Publish Gate Test',
            'visibility' => 'public',
            'timestamp' => 2000,
        ]])->assertStatus(200)->json();

    expect($json['publish_denied'])->toBe('anonymous')
        ->and($json['library']['visibility'])->toBe('private');
});

test('a routine re-sync of an already-public book is NOT gated', function () {
    // The gate keys on a TRANSITION. An unverified post-cutoff owner of an
    // already-public book (e.g. published while grandfathered, or public before
    // the rule) must keep syncing it public — otherwise every metadata edit
    // would silently unpublish it.
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    $owner = $this->loginUser(['email_verified_at' => null, 'created_at' => now()]);
    $book = $this->makeBook($owner, ['via' => 'app', 'visibility' => 'public']);

    $json = publishAttempt($this, $book);

    expect($json['publish_denied'])->toBeNull()
        ->and($json['library']['visibility'])->toBe('public');
});

test('with NO cutoff configured the gate is OFF — dev/e2e default, old behaviour preserved', function () {
    // config/publishing.php defaults to null outside production, so local dev and
    // the e2e suite (APP_ENV=local) are not hampered by the verify requirement.
    // This is the assertion that keeps notifications.spec.js green: a freshly-
    // registered, unverified user can still publish when the gate is off.
    config(['publishing.verified_email_required_after' => null]);

    $owner = $this->loginUser(['email_verified_at' => null, 'created_at' => now()]);
    $book = $this->makeBook($owner, ['via' => 'app']);
    $json = publishAttempt($this, $book);

    expect($json['publish_denied'])->toBeNull()
        ->and($json['library']['visibility'])->toBe('public');
});

test('bulkCreate cannot mint a book born public for an unverified account', function () {
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    $owner = $this->loginUser(['email_verified_at' => null, 'created_at' => now()]);
    $book = 'apitest_'.Str::random(10);

    $json = $this->postJson('/api/db/library/bulk-create', ['data' => [
        'book' => $book,
        'title' => 'Born Public',
        'visibility' => 'public',
    ]])->assertStatus(200)->json();

    expect($json['library']['visibility'])->toBe('private');
});
