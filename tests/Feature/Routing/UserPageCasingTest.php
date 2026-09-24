<?php

/**
 * `/u/{username}` has ONE canonical URL, and any casing reaches it.
 *
 * `/u/James` worked and `/u/james` was a hard 404, because the lookup seam
 * (`lookup_user_by_name`, SECURITY DEFINER) matched `name = p_name` exactly.
 * It did not strip spaces either, which made a second bug: routes/web.php
 * 301s `/MrJohns` -> `/u/MrJohns`, so any legacy user with a space in their
 * name was redirected INTO a 404.
 *
 * The redirect is 301 (permanent) and that is only safe because nothing
 * renames a user — `users.name` is a de-facto string foreign key compared
 * case-sensitively by ~99 RLS policies. A rename feature would invalidate
 * every one of these cached in the wild.
 *
 * Users are created via pgsql_admin (an RLS-rejected default INSERT), which
 * commits outside RefreshDatabase — cleaned up explicitly below.
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function makeCasingUser(string $name): void
{
    DB::connection('pgsql_admin')->table('users')->insert([
        'name' => $name,
        'email' => 'u_'.Str::random(8).'@case-route.local',
        'password' => bcrypt('password123'),
        'user_token' => Str::uuid()->toString(),
        'email_verified_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

afterEach(function () {
    $admin = DB::connection('pgsql_admin');
    $names = $admin->table('users')->where('email', 'like', '%@case-route.local')->pluck('name');
    if ($names->isNotEmpty()) {
        // The /u/ page mints pseudo-books for the user it renders.
        $admin->table('library')->whereIn('creator', $names)->delete();
        $admin->table('nodes')->whereIn('book', $names)->delete();
    }
    $admin->table('users')->where('email', 'like', '%@case-route.local')->delete();
});

test('the canonical casing renders', function () {
    $name = 'CaseRoute'.Str::random(6);
    makeCasingUser($name);

    $this->get("/u/{$name}")->assertStatus(200);
});

test('a mis-cased /u/ URL 301s to the stored casing', function () {
    $name = 'CaseRoute'.Str::random(6);
    makeCasingUser($name);

    foreach ([strtolower($name), strtoupper($name)] as $variant) {
        $this->get("/u/{$variant}")
            ->assertStatus(301)
            ->assertRedirect("/u/{$name}");
    }

    // ...and following it actually lands.
    $this->followingRedirects()->get('/u/'.strtolower($name))->assertStatus(200);
});

test('the query string survives the canonical redirect', function () {
    $name = 'CaseRoute'.Str::random(6);
    makeCasingUser($name);

    // Params are preserved, though getQueryString() normalizes them into
    // sorted order — deliberate: it also re-encodes, which is what keeps a
    // hand-built Location header safe.
    $this->get('/u/'.strtolower($name).'?tab=shelves&sort=connected')
        ->assertStatus(301)
        ->assertRedirect("/u/{$name}?sort=connected&tab=shelves");
});

test('a mis-cased shelf deep link keeps its shelf segment', function () {
    $name = 'CaseRoute'.Str::random(6);
    makeCasingUser($name);

    $this->get('/u/'.strtolower($name).'/shelf/some-shelf')
        ->assertStatus(301)
        ->assertRedirect("/u/{$name}/shelf/some-shelf");
});

test('an unknown username is still a 404, not a redirect loop', function () {
    $this->get('/u/nobody'.Str::random(10))->assertStatus(404);
});

test('a username stored with spaces resolves at its space-stripped URL', function () {
    // Previously a hard 404 on this path: lookup_user_by_name matched exactly,
    // while routes/web.php redirected /MrJohns here — a 301 into a 404.
    $suffix = Str::random(6);
    makeCasingUser('Mr Johns '.$suffix);

    $this->get("/u/MrJohns{$suffix}")->assertStatus(200);
    $this->get('/u/'.strtolower("mrjohns{$suffix}"))
        ->assertStatus(301)
        ->assertRedirect("/u/MrJohns{$suffix}");
});

test('the legacy /{name} redirect works for an ANONYMOUS visitor', function () {
    // This used to run User::where('name', ...) on the DEFAULT connection,
    // which is RLS-subject: users_select_policy limits SELECT to your OWN row,
    // so a logged-out visitor matched nothing and the username fell through to
    // be looked up as a book. The lookup now bypasses RLS deliberately.
    $name = 'CaseRoute'.Str::random(6);
    makeCasingUser($name);

    $this->assertGuest();

    $this->get("/{$name}")->assertStatus(301)->assertRedirect("/u/{$name}");
    $this->get('/'.strtolower($name))->assertStatus(301)->assertRedirect("/u/{$name}");
});

test('the page canonicalizes to the stored casing regardless of the URL asked for', function () {
    $name = 'CaseRoute'.Str::random(6);
    makeCasingUser($name);

    $canonical = url("/u/{$name}");

    $this->followingRedirects()->get('/u/'.strtolower($name))
        ->assertStatus(200)
        ->assertSee('<link rel="canonical" href="'.$canonical.'">', false)
        ->assertSee('<meta property="og:url" content="'.$canonical.'">', false);
});
