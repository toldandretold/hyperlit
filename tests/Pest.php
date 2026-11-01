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

    /*
     * Same trap, bigger surface: the CITATION-GRAPH tables. Suites all over the tree seed
     * bibliography / footnotes / canonical_source / hypercites via pgsql_admin (RLS makes the
     * default connection useless for it), those commits survive RefreshDatabase's rollback, and
     * any test that queries GLOBALLY — DocuverseEndpointTest asserts edge counts over the whole
     * graph — inherits every previous run's garbage. It bit twice in two days from two different
     * polluters (HyperciteConsoleTest's HX fixtures, then the golden-report suite's bibliography
     * + canonical rows); per-suite cleanup is whack-a-mole because the victim is never the
     * polluter. Cleared per test, BEFORE file-level beforeEach hooks, so a suite's own admin
     * seeding still lands on a clean slate. `library`/`nodes`/`users` are deliberately NOT
     * wiped — fixtures there are name-randomised per the username-identity gate, and wiping
     * them would break suites that legitimately accumulate user books across a file.
     */
    foreach (['bibliography', 'footnotes', 'canonical_source', 'hypercites'] as $table) {
        \Illuminate\Support\Facades\DB::connection('pgsql_admin')->table($table)->delete();
    }

    /*
     * Same shape again, third surface: LIVE DNS. UrlGuard::isSafeFetchUrl (the SSRF gate on
     * every fetch path) resolves hostnames via gethostbyname() even when the HTTP layer is
     * Http::fake()d — so every web-content / image-harvest / PDF-source test depended on the
     * machine's resolver. Under full-suite load macOS DNS intermittently failed for PUBLIC
     * hosts (example.org, silverchair-cdn.com — see "refused by UrlGuard" in laravel.log,
     * 2026-11-01) and 27 tests failed as `unreachable`/skipped while passing standalone.
     * Deterministic resolver: names that can never be public stay UNRESOLVED (returning the
     * input is gethostbyname()'s failure contract, so UrlGuard blocks them — keeping
     * SsrfPenetrationTest honest); everything else resolves to a fixed public IP. IP literals
     * never reach the resolver (UrlGuard checks them directly), so private-IP fixtures still
     * exercise the real range checks.
     */
    \App\Services\Security\UrlGuard::resolveHostUsing(function (string $host): string {
        foreach (['localhost', '.localhost', '.internal', '.local', '.test'] as $never) {
            if ($host === $never || str_ends_with($host, $never)) {
                return $host;
            }
        }

        // Only a dotted, letter-bearing DNS name "resolves" — a bracketed
        // IPv6 literal ([::1]), a decimal IP, or a bare label returns
        // unchanged, exactly what gethostbyname() does on a dev box, so the
        // SSRF suite's blocked verdicts stay honest.
        if (! preg_match('/^(?=.*[a-z])[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i', $host)) {
            return $host;
        }

        return '93.184.216.34';
    });
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
uses(SeedsRlsFixtures::class)->in('Feature/Security', 'Feature/Auth', 'Feature/E2ee', 'Feature/BookImages', 'Feature/BookAudio', 'Feature/Inference', 'Feature/Billing', 'Feature/Translation', 'Feature/Console', 'Feature/CitationMetadata', 'Feature/Account', 'Feature/Mcp');
afterEach(function () {
    if (method_exists($this, 'cleanupRlsFixtures')) {
        $this->cleanupRlsFixtures();
    }
})->in('Feature/Security', 'Feature/Auth', 'Feature/E2ee', 'Feature/BookImages', 'Feature/BookAudio', 'Feature/Inference', 'Feature/Billing', 'Feature/Translation', 'Feature/Account');

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
