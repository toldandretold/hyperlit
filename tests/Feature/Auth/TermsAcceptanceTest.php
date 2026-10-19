<?php

/**
 * Registration stamps terms acceptance — timestamp + version from
 * config('terms.version') — on BOTH register paths (the SPA API and the
 * Fortify fallback share UsernameRules so neither can be the lax one; same
 * principle here). The stamp is what turns the form's sign-in-wrap line into
 * an evidentiary record.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

afterEach(function () {
    DB::connection('pgsql_admin')->table('users')
        ->where('email', 'like', '%@terms-accept.local')->delete();
});

test('POST /api/register stamps terms_accepted_at and the current terms version', function () {
    $name = 'TermsA'.Str::random(6);

    $this->postJson('/api/register', [
        'name' => $name,
        'email' => 'a_'.Str::random(6).'@terms-accept.local',
        'password' => 'password123',
    ])->assertStatus(200);

    $row = DB::connection('pgsql_admin')->table('users')->where('name', $name)->first();
    expect($row->terms_accepted_at)->not->toBeNull();
    expect($row->terms_version)->toBe(config('terms.version'));
});

test('the no-JS /register fallback stamps identically', function () {
    $name = 'TermsB'.Str::random(6);

    $this->from('/register')->post('/register', [
        'name' => $name,
        'email' => 'b_'.Str::random(6).'@terms-accept.local',
        'password' => 'password123',
        'password_confirmation' => 'password123',
    ])->assertRedirect('/');

    $row = DB::connection('pgsql_admin')->table('users')->where('name', $name)->first();
    expect($row->terms_accepted_at)->not->toBeNull();
    expect($row->terms_version)->toBe(config('terms.version'));
});

test('config terms.version is a parseable date matching the documented shape', function () {
    // The version IS the effective date (config/terms.php binds them); a
    // typo'd value would silently stamp garbage into every new users row.
    $version = config('terms.version');
    expect($version)->toMatch('/^\d{4}-\d{2}-\d{2}$/');
    expect(fn () => \Carbon\Carbon::parse($version))->not->toThrow(Exception::class);
});
