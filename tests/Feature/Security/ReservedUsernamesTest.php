<?php

/**
 * Reserved-username blocklist (config/reserved-usernames.php).
 *
 * On 2026-09-22 an actor registered `admin`, `root`, `test` and the owner's own
 * handle `marx` in four seconds. Username validation only checked
 * config/reserved-routes.php (a URL-collision list), and none of those are
 * routes — so an impersonation defence had been resting on a list built for a
 * different purpose. This pins the dedicated identity blocklist across BOTH
 * registration paths (the SPA /api/register and the no-JS /register fallback)
 * and the vanity-slug path, which is reachable at /{slug} and can impersonate
 * exactly as a username can.
 *
 * Users are created via pgsql_admin (an RLS-rejected default INSERT), which
 * commits outside RefreshDatabase — the happy-path test cleans up explicitly.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    // Remove any users these tests actually created (only the happy-path one should).
    DB::connection('pgsql_admin')->table('users')->where('email', 'like', '%@resv-username.local')->delete();
});

test('SPA /api/register refuses a reserved identity username', function () {
    $this->postJson('/api/register', [
        'name' => 'admin',
        'email' => 'a_'.Str::random(6).'@resv-username.local',
        'password' => 'password123',
    ])->assertStatus(422)->assertJsonValidationErrors('name');

    expect(DB::connection('pgsql_admin')->table('users')->where('name', 'admin')->exists())->toBeFalse();
});

test('the blocklist is case-insensitive (the regex permits Admin / ROOT)', function () {
    foreach (['Admin', 'ROOT', 'Marx'] as $name) {
        $this->postJson('/api/register', [
            'name' => $name,
            'email' => strtolower($name).'_'.Str::random(6).'@resv-username.local',
            'password' => 'password123',
        ])->assertStatus(422)->assertJsonValidationErrors('name');
    }
});

test('the no-JS /register fallback refuses the same reserved names', function () {
    // This path (Fortify CreateNewUser) previously had NEITHER blocklist, so the
    // squat could just move here. It must reject identity names AND route names.
    $this->from('/register')->post('/register', [
        'name' => 'support',
        'email' => 's_'.Str::random(6).'@resv-username.local',
        'password' => 'password123',
        'password_confirmation' => 'password123',
    ])->assertSessionHasErrors('name');

    $this->from('/register')->post('/register', [
        'name' => 'maintainer', // a reserved ROUTE — also shadowed, also refused
        'email' => 'm_'.Str::random(6).'@resv-username.local',
        'password' => 'password123',
        'password_confirmation' => 'password123',
    ])->assertSessionHasErrors('name');

    expect(DB::connection('pgsql_admin')->table('users')->whereIn('name', ['support', 'maintainer'])->exists())->toBeFalse();
});

test('an ordinary username still registers', function () {
    $name = 'reader_'.Str::random(6);
    $this->postJson('/api/register', [
        'name' => $name,
        'email' => strtolower($name).'@resv-username.local',
        'password' => 'password123',
    ])->assertStatus(200);

    expect(DB::connection('pgsql_admin')->table('users')->where('name', $name)->exists())->toBeTrue();
});

test('setSlug refuses a reserved identity as a book slug', function () {
    $owner = \App\Models\User::on('pgsql_admin')->create([
        'name' => 'slugowner_'.Str::random(6),
        'email' => 'owner_'.Str::random(6).'@resv-username.local',
        'password' => bcrypt('password123'),
        'user_token' => Str::uuid()->toString(),
        'email_verified_at' => now(),
    ]);
    $book = 'apitest_'.Str::random(10);
    DB::connection('pgsql_admin')->table('library')->insert([
        'book' => $book,
        'title' => 'Slug Test',
        'creator' => $owner->name,
        'visibility' => 'public',
        'created_at' => now(),
        'updated_at' => now(),
        'raw_json' => json_encode(['book' => $book]),
    ]);

    try {
        $this->actingAs($owner)
            ->postJson('/api/db/library/set-slug', ['book' => $book, 'slug' => 'admin'])
            ->assertStatus(422)
            ->assertJson(['success' => false]);

        expect(DB::connection('pgsql_admin')->table('library')->where('book', $book)->value('slug'))->toBeNull();
    } finally {
        DB::connection('pgsql_admin')->table('library')->where('book', $book)->delete();
    }
});
