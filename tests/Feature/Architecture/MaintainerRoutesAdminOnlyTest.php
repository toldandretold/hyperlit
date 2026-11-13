<?php

/**
 * Every operator route is admin-gated BY THE ROUTE TABLE (review gate).
 *
 * The workbench pages used to be gated by a per-controller `isAdmin()` check
 * each new page had to remember, and the per-page tests only assert a
 * hand-picked subset of endpoints (about 45 of 74 maintainer API routes had a
 * 403 assertion). A page or endpoint that forgot its check was public, and
 * nothing would have said so.
 *
 * Two contracts, both enforced here by walking the real route table:
 *   - PAGES   /maintainer/*            carry `admin.page`  (404 — not advertised)
 *   - API     /api/maintainer/*  and
 *             /api/conversion-tests/*  carry `auth:sanctum` + `admin` (401 / 403)
 *
 * A workbench opened to NON-admins (e.g. a shelf owner's) must live OUTSIDE
 * these prefixes with its own gate — never by loosening one of these.
 */

use Illuminate\Support\Facades\Route;

function operatorRoutesMissing(string $uriPattern, array $required): array
{
    $missing = [];
    foreach (Route::getRoutes() as $route) {
        if (! preg_match($uriPattern, $route->uri())) {
            continue;
        }
        $active = array_diff($route->gatherMiddleware(), $route->excludedMiddleware());
        foreach ($required as $m) {
            if (! in_array($m, $active, true)) {
                $missing[] = implode('|', $route->methods()).' /'.$route->uri()." (missing {$m})";
            }
        }
    }
    sort($missing);

    return $missing;
}

test('every /maintainer page route carries the admin.page gate', function () {
    expect(operatorRoutesMissing('#^maintainer(/|$)#', ['admin.page']))->toBe([],
        'A /maintainer page route is not behind `admin.page` — it is PUBLIC. Register it inside the '
        .'Route::prefix(\'maintainer\')->middleware(\'admin.page\') group in routes/web.php.');
});

test('every operator API route carries auth:sanctum + admin', function () {
    expect(operatorRoutesMissing('#^api/(maintainer|conversion-tests)(/|$)#', ['auth:sanctum', 'admin']))->toBe([],
        'An operator API route is not behind `auth:sanctum` + `admin`. Register it inside the '
        .'admin group in routes/api.php. A tool for non-admins belongs under its own prefix and gate.');
});

test('the gate actually finds the operator routes (it is not vacuous)', function () {
    $pages = $api = 0;
    foreach (Route::getRoutes() as $route) {
        $pages += (int) preg_match('#^maintainer(/|$)#', $route->uri());
        $api += (int) preg_match('#^api/maintainer/#', $route->uri());
    }
    expect($pages)->toBeGreaterThan(10)->and($api)->toBeGreaterThan(50);
});

test('admin.page answers 404 to guests and non-admins, 200 to an admin', function () {
    $this->get('/maintainer/jobs')->assertNotFound();

    $user = \App\Models\User::on('pgsql_admin')->create([
        'name' => 'gate_'.\Illuminate\Support\Str::lower(\Illuminate\Support\Str::random(8)),
        'email' => 'gate_'.\Illuminate\Support\Str::random(8).'@test.local',
        'password' => bcrypt('x'),
        'user_token' => (string) \Illuminate\Support\Str::uuid(),
    ]);
    try {
        $this->actingAs($user)->get('/maintainer/jobs')->assertNotFound();
        $this->actingAs($user)->get('/maintainer')->assertNotFound();

        \Illuminate\Support\Facades\DB::connection('pgsql_admin')->table('users')
            ->where('id', $user->id)->update(['is_admin' => true]);
        $this->actingAs($user)->get('/maintainer/jobs')->assertOk();
    } finally {
        \Illuminate\Support\Facades\DB::connection('pgsql_admin')->table('users')->where('id', $user->id)->delete();
    }
});
