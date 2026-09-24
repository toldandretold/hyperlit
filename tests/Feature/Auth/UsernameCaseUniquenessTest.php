<?php

/**
 * Usernames are case-insensitively unique.
 *
 * Before this, uniqueness was `unique:pgsql_admin.users,name` — case-sensitive,
 * with NO unique index behind it. So `James` and `james` were two accounts
 * fighting over one `/u/` URL, and (since nothing enforced it in the database)
 * two simultaneous signups of the IDENTICAL name both succeeded. After the
 * 2026-09-22 squat (see ReservedUsernamesTest) a case variant is also an
 * impersonation vector: the blocklist stops `marx`, nothing stopped `Marx`.
 *
 * Both registration paths must hold the line identically — they share
 * App\Support\UsernameRules precisely so the no-JS fallback can't be the
 * laxer one.
 *
 * Users are created via pgsql_admin (an RLS-rejected default INSERT), which
 * commits outside RefreshDatabase — everything here is cleaned up explicitly.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    DB::connection('pgsql_admin')->table('users')
        ->where('email', 'like', '%@case-uniq.local')->delete();
});

test('a case variant of a taken username is refused by /api/register', function () {
    $name = 'CaseUniq'.Str::random(6);

    $this->postJson('/api/register', [
        'name' => $name,
        'email' => 'a_'.Str::random(6).'@case-uniq.local',
        'password' => 'password123',
    ])->assertStatus(200);

    foreach ([strtolower($name), strtoupper($name)] as $variant) {
        $this->postJson('/api/register', [
            'name' => $variant,
            'email' => 'b_'.Str::random(6).'@case-uniq.local',
            'password' => 'password123',
        ])->assertStatus(422)->assertJsonValidationErrors('name');
    }

    // Exactly one account owns that identity.
    expect(DB::connection('pgsql_admin')->table('users')
        ->whereRaw("lower(replace(name, ' ', '')) = ?", [strtolower($name)])
        ->count())->toBe(1);
});

test('the no-JS /register fallback refuses the same case variant', function () {
    // Seeded directly, NOT through /api/register: that would log this client
    // in, and /register is behind `guest` middleware — the POST would be
    // redirected without ever reaching validation, and the test would pass
    // for the wrong reason.
    $name = 'CaseFall'.Str::random(6);
    DB::connection('pgsql_admin')->table('users')->insert([
        'name' => $name,
        'email' => 'c_'.Str::random(6).'@case-uniq.local',
        'password' => bcrypt('password123'),
        'user_token' => Str::uuid()->toString(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    // Both paths share UsernameRules — the fallback must not be a way around it.
    $this->from('/register')->post('/register', [
        'name' => strtolower($name),
        'email' => 'd_'.Str::random(6).'@case-uniq.local',
        'password' => 'password123',
        'password_confirmation' => 'password123',
    ])->assertSessionHasErrors('name');
});

test('a username colliding only on stripped spaces is refused', function () {
    // Legacy names may contain spaces and the URL form strips them, so
    // `Mr Johns` and `MrJohns` are ONE identity, not two.
    $suffix = Str::random(6);
    DB::connection('pgsql_admin')->table('users')->insert([
        'name' => 'Mr Johns '.$suffix,
        'email' => 'e_'.Str::random(6).'@case-uniq.local',
        'password' => bcrypt('password123'),
        'user_token' => Str::uuid()->toString(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $this->postJson('/api/register', [
        'name' => 'MrJohns'.$suffix,
        'email' => 'f_'.Str::random(6).'@case-uniq.local',
        'password' => 'password123',
    ])->assertStatus(422)->assertJsonValidationErrors('name');
});

test('the reserved-route list is matched case-insensitively', function () {
    // Rule::notIn was case-sensitive, so these all used to pass. Once identity
    // is case-insensitive, `Maintainer` and `maintainer` are one name.
    foreach (['Maintainer', 'API', 'Login'] as $name) {
        $this->postJson('/api/register', [
            'name' => $name,
            'email' => strtolower($name).'_'.Str::random(6).'@case-uniq.local',
            'password' => 'password123',
        ])->assertStatus(422)->assertJsonValidationErrors('name');
    }
});

test('the DATABASE refuses a colliding insert, not just the validator', function () {
    // This is the race the validator cannot close: two signups both pass their
    // uniqueness check and one INSERT loses. Until users_name_url_unique
    // existed there was no unique index on `name` at all, so the loser simply
    // succeeded and created a duplicate account.
    $name = 'CaseIdx'.Str::random(6);
    $row = [
        'name' => $name,
        'email' => 'g_'.Str::random(6).'@case-uniq.local',
        'password' => bcrypt('password123'),
        'user_token' => Str::uuid()->toString(),
        'created_at' => now(),
        'updated_at' => now(),
    ];
    DB::connection('pgsql_admin')->table('users')->insert($row);

    expect(fn () => DB::connection('pgsql_admin')->table('users')->insert(array_merge($row, [
        'name' => strtolower($name),
        'email' => 'h_'.Str::random(6).'@case-uniq.local',
        'user_token' => Str::uuid()->toString(),
    ])))->toThrow(\Illuminate\Database\QueryException::class);
});

test('an ordinary username still registers', function () {
    $name = 'caseok_'.Str::random(6);

    $this->postJson('/api/register', [
        'name' => $name,
        'email' => 'i_'.Str::random(6).'@case-uniq.local',
        'password' => 'password123',
    ])->assertStatus(200);

    expect(DB::connection('pgsql_admin')->table('users')->where('name', $name)->exists())->toBeTrue();
});
