<?php

/**
 * Money overlay content endpoint — GET /api/billing/account-panel.
 *
 * Returns the caller's `{sanitized}Account` synthetic book HTML (balance card
 * + ledger) for the any-page overlay. Owner-only (session); the account book
 * is generated on demand by the same guard the profile visit uses.
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function bapAdminConn()
{
    return DB::connection('pgsql_admin');
}

function makeBapUser(): User
{
    $unique = 'bap_' . Str::random(8);
    $id = bapAdminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@baptest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'budget',
        'credits'    => 5.00,
        'debits'     => 1.25,
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

beforeEach(function () {
    bapAdminConn()->table('billing_ledger')->whereRaw("user_id IN (SELECT id FROM users WHERE email LIKE '%@baptest.test')")->delete();
    bapAdminConn()->table('nodes')->whereRaw("book IN (SELECT book FROM library WHERE creator IN (SELECT name FROM users WHERE email LIKE '%@baptest.test'))")->delete();
    bapAdminConn()->table('library')->whereRaw("creator IN (SELECT name FROM users WHERE email LIKE '%@baptest.test')")->delete();
    bapAdminConn()->table('users')->whereRaw("email LIKE '%@baptest.test'")->delete();
});

test('rejects unauthenticated requests with 401', function () {
    $this->getJson('/api/billing/account-panel')->assertStatus(401);
});

test('returns the account book html with the balance card', function () {
    $user = makeBapUser();

    $response = $this->actingAs($user)->getJson('/api/billing/account-panel');

    $response->assertStatus(200);
    $html = $response->json('html');
    expect($html)->toContain('totalCredit');
    expect($html)->toContain('tier-selector');
    expect($html)->toContain('stripe-topup');
});

function seedBapLedger(User $user): void
{
    bapAdminConn()->table('billing_ledger')->insert([
        [
            'id' => (string) Str::uuid(), 'user_id' => $user->id, 'type' => 'debit',
            'amount' => 0.0123, 'description' => 'AI Archivist: test question', 'category' => 'ai_brain',
            'balance_after' => 3.7377, 'created_at' => now()->subDay(),
        ],
        [
            'id' => (string) Str::uuid(), 'user_id' => $user->id, 'type' => 'credit',
            'amount' => 5.0000, 'description' => '=HYPERLINK("evil") top up', 'category' => 'topup',
            'balance_after' => 3.7500, 'created_at' => now()->subDays(2),
        ],
    ]);
}

test('ledger export: csv has all entries, signed amounts, and formula-injection guard', function () {
    $user = makeBapUser();
    seedBapLedger($user);

    $response = $this->actingAs($user)->get('/api/billing/ledger/export?format=csv');

    $response->assertStatus(200);
    $response->assertHeader('Content-Disposition');
    $csv = $response->getContent();
    expect($csv)->toContain('date,type,category,description,amount,balance_after');
    expect($csv)->toContain('AI Archivist: test question');
    expect($csv)->toContain('-0.0123');
    // formula-injection guard: leading = gets an apostrophe prefix
    expect($csv)->toContain('"\'=HYPERLINK(""evil"") top up"');
});

test('ledger export: markdown is a bullet list with balance summary', function () {
    $user = makeBapUser();
    seedBapLedger($user);

    $response = $this->actingAs($user)->get('/api/billing/ledger/export?format=md');

    $response->assertStatus(200);
    $md = $response->getContent();
    expect($md)->toContain('# Hyperlit ledger — ' . $user->name);
    expect($md)->toContain('- **-$0.01** — AI Archivist: test question · ai_brain');
    expect($md)->toContain('- **+$5.00** —');
    expect($md)->not->toContain('|'); // house style: no markdown tables
});

test('ledger export rejects unauthenticated requests', function () {
    $this->getJson('/api/billing/ledger/export')->assertStatus(401);
});
