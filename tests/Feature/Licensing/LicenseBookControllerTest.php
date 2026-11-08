<?php

/**
 * Custom licences are BOOKS (LicenseBookController): mint one from typed terms, list the ones
 * a user already uses, count/re-apply the works pinned to it, and the public lookup a reader's
 * licence line uses.
 */

use App\Models\PgLibrary;

beforeEach(function () {
    $this->user = $this->seedUser();
});

test('minting a licence book creates a PUBLIC book with one node per paragraph', function () {
    $res = $this->actingAs($this->user)->postJson('/api/license-books', [
        'title' => 'Test Commons Licence',
        'text' => "You may share this.\n\nYou may not sell it.",
    ])->assertOk()->json();

    expect($res['success'])->toBeTrue();
    $book = PgLibrary::where('book', $res['book'])->firstOrFail();
    expect($book->visibility)->toBe('public');
    expect($book->creator)->toBe($this->user->name);
    expect($book->license)->toBe('CC0');

    $texts = \Illuminate\Support\Facades\DB::table('nodes')->where('book', $res['book'])
        ->orderByRaw('"startLine"::numeric')->pluck('content')->all();
    expect($texts)->toHaveCount(3); // h1 + two paragraphs
    expect($texts[0])->toContain('Test Commons Licence');
    expect($texts[2])->toContain('You may not sell it.');
});

test('minting escapes the typed terms', function () {
    $res = $this->actingAs($this->user)->postJson('/api/license-books', [
        'title' => 'X', 'text' => '<script>alert(1)</script>',
    ])->assertOk()->json();
    $html = \Illuminate\Support\Facades\DB::table('nodes')->where('book', $res['book'])->pluck('content')->implode('');
    expect($html)->not->toContain('<script>');
});

test('an unverified post-cutoff account cannot mint a (public) licence book', function () {
    // The gate is OFF outside production unless configured — tests set it explicitly.
    config(['publishing.verified_email_required_after' => now()->subDay()->toIso8601String()]);
    $unverified = $this->seedUser(['email_verified_at' => null]);
    $this->actingAs($unverified)->postJson('/api/license-books', ['title' => 'X', 'text' => 'Y'])
        ->assertStatus(403);
});

test('anonymous visitors cannot list or mint licence books', function () {
    $this->getJson('/api/license-books')->assertStatus(401);
    $this->postJson('/api/license-books', ['title' => 'X', 'text' => 'Y'])->assertStatus(401);
});

test('index lists licences in use and other public books as candidates', function () {
    $owner = ['creator' => $this->user->name, 'creator_token' => $this->user->user_token, 'visibility' => 'public', 'has_nodes' => true];
    $this->seedLibrary(['book' => 'lbc_terms', 'title' => 'Terms'] + $owner);
    $this->seedLibrary(['book' => 'lbc_other', 'title' => 'Other'] + $owner);
    $this->seedLibrary(['book' => 'lbc_work', 'title' => 'Work', 'license' => 'custom', 'license_book' => 'lbc_terms', 'license_book_at' => 1] + $owner);

    $res = $this->actingAs($this->user)->getJson('/api/license-books')->assertOk()->json();
    expect(collect($res['used'])->pluck('book')->all())->toBe(['lbc_terms']);
    expect(collect($res['candidates'])->pluck('book')->all())->toContain('lbc_other');
    expect(collect($res['candidates'])->pluck('book')->all())->not->toContain('lbc_terms');
});

test('usage counts outdated pins and reapply moves only the owner\'s works forward', function () {
    $other = $this->seedUser();
    $owner = ['creator' => $this->user->name, 'creator_token' => $this->user->user_token, 'visibility' => 'public'];
    $this->seedLibrary(['book' => 'lbc_t2', 'title' => 'Terms', 'timestamp' => 5_000] + $owner);
    $this->seedLibrary(['book' => 'lbc_w1', 'title' => 'W1', 'license' => 'custom', 'license_book' => 'lbc_t2', 'license_book_at' => 1_000] + $owner);
    $this->seedLibrary(['book' => 'lbc_w2', 'title' => 'W2', 'license' => 'custom', 'license_book' => 'lbc_t2', 'license_book_at' => 9_000] + $owner);
    // Someone else's work pointing at it (cannot happen via upsert, but reapply must not touch it).
    $this->seedLibrary(['book' => 'lbc_foreign', 'title' => 'F', 'creator' => $other->name, 'creator_token' => $other->user_token, 'visibility' => 'public', 'license' => 'custom', 'license_book' => 'lbc_t2', 'license_book_at' => 1_000]);

    $usage = $this->actingAs($this->user)->getJson('/api/license-books/lbc_t2/usage')->assertOk()->json();
    expect($usage['total'])->toBe(2);
    expect($usage['outdated'])->toBe(1);

    $res = $this->actingAs($this->user)->postJson('/api/license-books/lbc_t2/reapply')->assertOk()->assertJson(['updated' => 2])->json();
    // The works' content clock moves too, or open readers keep their cached (old) pin.
    expect((int) \App\Models\PgLibrary::where('book', 'lbc_w1')->value('timestamp'))->toBe((int) $res['license_book_at']);
    expect((int) \Illuminate\Support\Facades\DB::connection('pgsql_admin')->table('library')->where('book', 'lbc_foreign')->value('license_book_at'))->toBe(1_000);

    $this->actingAs($other)->postJson('/api/license-books/lbc_t2/reapply')->assertStatus(403);
});

test('info is public for a public licence book and absent for a private one', function () {
    $owner = ['creator' => $this->user->name, 'creator_token' => $this->user->user_token];
    $this->seedLibrary(['book' => 'lbc_pub', 'title' => 'Pub Terms', 'visibility' => 'public', 'timestamp' => 123] + $owner);
    $this->seedLibrary(['book' => 'lbc_priv', 'title' => 'Priv', 'visibility' => 'private'] + $owner);

    $this->getJson('/api/license-books/lbc_pub/info')->assertOk()->assertJson([
        'available' => true, 'title' => 'Pub Terms', 'url' => '/lbc_pub', 'timemachine_base' => '/lbc_pub/timemachine', 'changed_at' => 123,
    ]);
    $this->getJson('/api/license-books/lbc_priv/info')->assertOk()->assertJson(['available' => false]);
});
