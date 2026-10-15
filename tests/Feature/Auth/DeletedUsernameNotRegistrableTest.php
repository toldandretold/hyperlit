<?php

/**
 * A username retired by account deletion is permanently non-registrable.
 *
 * Account deletion tombstones the users row (billing_ledger's FK forbids a
 * hard delete), renaming it to `deleted_{id}` — which would otherwise FREE the
 * original name. The /u/ canonicalization 301 is permanent and leftover
 * attributed/anonymized bylines keep pointing at the old URL, so a
 * re-registered name (or a book slug squatting /{oldname}) would silently
 * inherit both. `deleted_usernames.name_key` holds the retired identity key;
 * UniqueUsername, SlugRules, and the `deleted_\d` prefix closure in
 * UsernameRules enforce it.
 *
 * Rows are written via pgsql_admin, which commits outside RefreshDatabase —
 * everything here is cleaned up explicitly.
 */

use App\Support\SlugRules;
use App\Support\UsernameKey;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    DB::connection('pgsql_admin')->table('deleted_usernames')
        ->where('name', 'ilike', 'retiredname%')->delete();
    DB::connection('pgsql_admin')->table('users')
        ->where('email', 'like', '%@retired-name.local')->delete();
});

function retireName(string $name): void
{
    DB::connection('pgsql_admin')->table('deleted_usernames')->insert([
        'user_id' => 999999,
        'name' => $name,
        'name_key' => UsernameKey::for($name),
        'deleted_at' => now(),
    ]);
}

test('a retired username is refused by /api/register, including case and space variants', function () {
    $name = 'RetiredName'.Str::random(6);
    retireName($name);

    foreach ([$name, strtolower($name), strtoupper($name)] as $variant) {
        $this->postJson('/api/register', [
            'name' => $variant,
            'email' => 'a_'.Str::random(6).'@retired-name.local',
            'password' => 'password123',
        ])->assertStatus(422)->assertJsonValidationErrors('name');
    }

    expect(DB::connection('pgsql_admin')->table('users')
        ->whereRaw("lower(replace(name, ' ', '')) = ?", [UsernameKey::for($name)])
        ->exists())->toBeFalse();
});

test('the no-JS /register fallback refuses a retired username too', function () {
    $name = 'RetiredName'.Str::random(6);
    retireName($name);

    $this->from('/register')->post('/register', [
        'name' => $name,
        'email' => 'b_'.Str::random(6).'@retired-name.local',
        'password' => 'password123',
        'password_confirmation' => 'password123',
    ])->assertSessionHasErrors('name');
});

test('the tombstone namespace deleted_{id} cannot be pre-squatted', function () {
    foreach (['deleted_42', 'Deleted_7abc'] as $candidate) {
        $this->postJson('/api/register', [
            'name' => $candidate,
            'email' => 'c_'.Str::random(6).'@retired-name.local',
            'password' => 'password123',
        ])->assertStatus(422)->assertJsonValidationErrors('name');
    }

    // Names merely containing the word remain legal — only the prefix shape
    // collides with a future tombstone rename.
    $this->postJson('/api/register', [
        'name' => 'undeleted_4ever'.Str::random(4),
        'email' => 'd_'.Str::random(6).'@retired-name.local',
        'password' => 'password123',
    ])->assertStatus(200);
});

test('a retired username is refused as a book slug', function () {
    // Slugs are lowercase-only by format, so retire a name whose key IS a
    // valid slug shape and probe the one shared gauntlet directly.
    $name = 'retiredname'.strtolower(Str::random(6));
    retireName($name);

    expect(SlugRules::rejectionReason($name))->not->toBeNull();
});
