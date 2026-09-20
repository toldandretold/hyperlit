<?php

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Feature\Api\Support\InteractsWithApi;
use Tests\Support\SeedsRlsFixtures;
use Tests\TestCase;

/*
|--------------------------------------------------------------------------
| Test Case
|--------------------------------------------------------------------------
|
| The closure you provide to your test functions is always bound to a specific PHPUnit test
| case class. By default, that class is "PHPUnit\Framework\TestCase". Of course, you may
| need to change it using the "uses()" function to bind a different classes or traits.
|
*/

uses(TestCase::class, RefreshDatabase::class)->in('Feature');

/*
 * `fetch_host_reachability` is written on the **pgsql_admin** connection, which
 * escapes RefreshDatabase's transaction rollback — so a host that one test
 * marks as blocked stays blocked for every test after it, and they start
 * getting `channel=cooldown` instead of the grade they set up. That bit seven
 * tests the moment host memory landed: each passed alone and failed in the
 * suite, all of them sharing `example.com`.
 *
 * Cleared for the whole Feature suite rather than per file, because the trap is
 * invisible (a test that never mentions FetchHostHealth can still be its
 * victim) and any future test using a shared hostname would hit it.
 */
uses()->beforeEach(function () {
    \Illuminate\Support\Facades\DB::connection('pgsql_admin')
        ->table('fetch_host_reachability')
        ->delete();
})->in('Feature', 'Canonical');

// Canonical version-control suite (tests/Canonical): same Laravel TestCase
// binding as Feature, kept as its own top-level testsuite so it can run alone
// via `php artisan test --testsuite=Canonical`.
uses(TestCase::class, RefreshDatabase::class)->in('Canonical');

// API endpoint suite: bind the shared helper trait (loginUser/makeBook/anonSession/
// assertApiError) to every test under tests/Feature/Api/. See InteractsWithApi.
uses(InteractsWithApi::class)->in('Feature/Api');

// Security/Auth suites seed users (and some pre-seed owned content) directly; under RLS
// a bare User::factory()->create() is rejected (see SeedsRlsFixtures). Bind the admin-
// seeding helpers + auto-clean the admin-committed rows after each test.
uses(SeedsRlsFixtures::class)->in('Feature/Security', 'Feature/Auth', 'Feature/E2ee', 'Feature/BookImages', 'Feature/BookAudio', 'Feature/Inference', 'Feature/Billing', 'Feature/Translation', 'Feature/Console', 'Feature/CitationMetadata');
afterEach(function () {
    if (method_exists($this, 'cleanupRlsFixtures')) {
        $this->cleanupRlsFixtures();
    }
})->in('Feature/Security', 'Feature/Auth', 'Feature/E2ee', 'Feature/BookImages', 'Feature/BookAudio', 'Feature/Inference', 'Feature/Billing', 'Feature/Translation');

// E2EE passkey ceremony tests forge real WebAuthn credentials (CBOR + ES256).
uses(Tests\Support\MakesWebAuthnCredentials::class)->in('Feature/E2ee');

/*
|--------------------------------------------------------------------------
| Expectations
|--------------------------------------------------------------------------
|
| When you're writing tests, you often need to check that values meet certain conditions. The
| "expect()" function gives you access to a set of "expectations" methods that you can use
| to assert different things. Of course, you may extend the Expectation API at any time.
|
*/

expect()->extend('toBeOne', function () {
    return $this->toBe(1);
});

/*
|--------------------------------------------------------------------------
| Functions
|--------------------------------------------------------------------------
|
| While Pest is very powerful out-of-the-box, you may have some testing code specific to your
| project that you don't want to repeat in every file. Here you can also expose helpers as
| global functions to help you to reduce the number of lines of code in your test files.
|
*/

function something()
{
    // ..
}
