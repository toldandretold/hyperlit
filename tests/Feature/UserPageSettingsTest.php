<?php

/**
 * /u/{username} hero-page customization — PUT /api/user-home/page-settings.
 *
 * This payload is rendered to EVERY visitor of the page (css vars into a
 * <style> block, about_html printed raw), so the validator is a security
 * boundary: variable NAMES are allowlisted AND their VALUES grammar-checked
 * (hex colors / font tokens / clamped lengths — never free CSS), image
 * filenames must exist in book_images for the user-home book, and about_html
 * passes NodeHtmlSanitizer. The target row is always derived from the
 * session, never the payload.
 */

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function upsAdminConn()
{
    return DB::connection('pgsql_admin');
}

function makeUpsUser(string $prefix): User
{
    $unique = $prefix . '_' . Str::random(8);
    $id = upsAdminConn()->table('users')->insertGetId([
        'name'       => $unique,
        'email'      => $unique . '@upstest.test',
        'password'   => bcrypt('x'),
        'user_token' => (string) Str::uuid(),
        'status'     => 'budget',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return User::on('pgsql_admin')->find($id);
}

function makeUpsHomeBook(User $user): string
{
    $book = str_replace(' ', '', $user->name);
    upsAdminConn()->table('library')->insert([
        'book'       => $book,
        'title'      => $user->name . "'s library",
        'creator'    => $user->name,
        'visibility' => 'public',
        'listed'     => false,
        'raw_json'   => json_encode(['type' => 'user_home', 'username' => $user->name]),
        'timestamp'  => (int) round(microtime(true) * 1000),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
    return $book;
}

function upsSettings(string $book): ?array
{
    $raw = upsAdminConn()->table('library')->where('book', $book)->value('page_settings');
    return $raw ? json_decode($raw, true) : null;
}

beforeEach(function () {
    upsAdminConn()->table('book_images')->whereRaw("book IN (SELECT name FROM users WHERE email LIKE '%@upstest.test')")->delete();
    upsAdminConn()->table('library')->whereRaw("creator IN (SELECT name FROM users WHERE email LIKE '%@upstest.test')")->delete();
    upsAdminConn()->table('users')->whereRaw("email LIKE '%@upstest.test'")->delete();
});

test('rejects unauthenticated requests with 401', function () {
    $response = $this->putJson('/api/user-home/page-settings', ['css_vars' => ['--up-accent' => '#ff0000']]);
    $response->assertStatus(401);
});

test('404s when the user-home book row does not exist yet', function () {
    $user = makeUpsUser('ups_norow');

    $response = $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'css_vars' => ['--up-accent' => '#ff0000'],
    ]);

    $response->assertStatus(404);
});

test('writes land only on the OWN user-home row and merge partially', function () {
    $user = makeUpsUser('ups_owner');
    $book = makeUpsHomeBook($user);
    $other = makeUpsUser('ups_other');
    $otherBook = makeUpsHomeBook($other);

    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'css_vars' => ['--up-accent' => '#ff0000'],
    ])->assertStatus(200);

    // Second partial write must merge, not clobber
    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'about_html' => '<p>My about</p>',
    ])->assertStatus(200);

    $settings = upsSettings($book);
    expect($settings['css_vars']['--up-accent'])->toBe('#ff0000');
    expect($settings['about_html'])->toContain('My about');
    expect(upsSettings($otherBook))->toBeNull();
});

test('accepts valid colors, font tokens and sizes; explicit null clears', function () {
    $user = makeUpsUser('ups_valid');
    $book = makeUpsHomeBook($user);

    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'css_vars' => [
            '--up-accent' => '#EE4a96',
            '--up-title-font' => 'serif',
            '--up-title-size' => '2.5rem',
        ],
    ])->assertStatus(200);

    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'css_vars' => null,
    ])->assertStatus(200);

    expect(upsSettings($book))->toBeNull();
});

test('show_map stores the OPT-OUT only — on is the default and stores nothing', function () {
    $user = makeUpsUser('ups_showmap');
    $book = makeUpsHomeBook($user);

    // Off is a real stored state (false), because absent means SHOWN.
    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'show_map' => false,
    ])->assertStatus(200);
    expect(upsSettings($book))->toBe(['show_map' => false]);

    // Back on → the key is cleared rather than stored as true.
    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'show_map' => true,
    ])->assertStatus(200);
    expect(upsSettings($book))->toBeNull();

    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'show_map' => 'yes',
    ])->assertStatus(422);
});

test('rejects unknown variable names and non-grammar values', function () {
    $user = makeUpsUser('ups_badvars');
    makeUpsHomeBook($user);

    $cases = [
        ['--up-evil' => '#ff0000'],                       // unknown name
        ['--up-accent' => 'red'],                          // not hex
        ['--up-accent' => '#ff0000; background: url(x)'],  // breakout attempt
        ['--up-accent' => '#ff0000}body{display:none'],    // rule-block breakout
        ['--up-title-font' => 'Comic Sans MS, cursive'],   // free-text font
        ['--up-title-size' => '400px'],                    // out of range
        ['--up-title-size' => 'calc(1px)'],                // not a simple length
    ];

    foreach ($cases as $vars) {
        $response = $this->actingAs($user)->putJson('/api/user-home/page-settings', ['css_vars' => $vars]);
        $response->assertStatus(422);
    }
});

test('sanitizes about_html and stores the cleaned form', function () {
    $user = makeUpsUser('ups_about');
    $book = makeUpsHomeBook($user);

    $response = $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'about_html' => '<h1>Hello</h1><script>alert(1)</script><img src=x onerror=alert(1)>',
    ]);

    $response->assertStatus(200);
    $stored = upsSettings($book)['about_html'];
    expect($stored)->toContain('Hello');
    expect($stored)->not->toContain('<script');
    expect($stored)->not->toContain('onerror');
    // The response echoes the canonical (sanitized) form for the client to re-render
    expect($response->json('page_settings.about_html'))->toBe($stored);
});

test('image filenames must exist in book_images for this page', function () {
    $user = makeUpsUser('ups_img');
    $book = makeUpsHomeBook($user);

    // Unknown filename rejected
    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'logo_image' => 'nope.png',
    ])->assertStatus(422);

    // Traversal-shaped filename rejected by grammar before any lookup
    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'logo_image' => '../secrets.png',
    ])->assertStatus(422);

    upsAdminConn()->table('book_images')->insert([
        'id'         => (string) Str::uuid(),
        'book'       => $book,
        'filename'   => 'ab12-logo.png',
        'mime'       => 'image/png',
        'bytes'      => 1234,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'logo_image' => 'ab12-logo.png',
    ])->assertStatus(200);

    expect(upsSettings($book)['logo_image'])->toBe('ab12-logo.png');
});

test('page_settings and a custom title survive home-book regeneration', function () {
    $user = makeUpsUser('ups_regen');
    $book = makeUpsHomeBook($user);

    upsAdminConn()->table('library')->where('book', $book)->update(['title' => 'My Cool Library']);
    $this->actingAs($user)->putJson('/api/user-home/page-settings', [
        'css_vars' => ['--up-accent' => '#123abc'],
    ])->assertStatus(200);

    app(\App\Http\Controllers\UserHomeServerController::class)
        ->generateUserHomeBook($user->name, true, 'public');

    $row = upsAdminConn()->table('library')->where('book', $book)->first();
    expect($row->title)->toBe('My Cool Library');
    expect(json_decode($row->page_settings, true)['css_vars']['--up-accent'])->toBe('#123abc');
});
