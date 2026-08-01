<?php

/**
 * The route-collision gate.
 *
 * Hyperlit resolves any unmatched single-segment URL as a book (the
 * /{identifier} catch-all in routes/web.php), so every literal first path
 * segment the app registers is a word books, slugs and usernames can never
 * have — a book slugged "maintainer" is silently shadowed and unreachable.
 *
 * config/reserved-routes.php is the single source of truth for that set, and
 * this test is what keeps it true: it walks the REAL route table and fails on
 * any literal first segment that isn't declared. The predecessor of that list
 * was a hand-maintained array inside DbLibraryController and it went stale
 * exactly as you'd expect — it never learned about /q, /3d, /dev or /maintainer.
 *
 * Adding a root-level route? Declare its first segment in the config (and
 * prefer a prefixed namespace, so you spend one word rather than one per page).
 */

use Illuminate\Support\Facades\Route;

/** Literal (non-parameter) first path segments actually registered by the app. */
function registeredRootSegments(): array
{
    $segments = [];

    foreach (Route::getRoutes() as $route) {
        $first = explode('/', ltrim($route->uri(), '/'))[0] ?? '';

        // '' is the homepage; '{book}' and friends are the catch-alls this
        // whole gate exists to protect.
        if ($first === '' || str_starts_with($first, '{')) {
            continue;
        }

        $segments[$first] = true;
    }

    return array_keys($segments);
}

test('every root route segment is declared in config/reserved-routes.php', function () {
    $reserved = config('reserved-routes');
    $missing = array_values(array_diff(registeredRootSegments(), $reserved));

    expect($missing)->toBe([], $missing === []
        ? ''
        : "These root path segments are routable but NOT reserved, so a book slug or username\n"
          . "of the same name would be shadowed (unreachable). Add them to config/reserved-routes.php:\n"
          . '  ' . implode(', ', $missing));
});

test('the reserved list has no duplicates', function () {
    $reserved = config('reserved-routes');

    expect(count($reserved))->toBe(count(array_unique($reserved)));
});

test('slug validation refuses every reserved word', function () {
    // The gate is only worth having if the validation path actually consumes
    // it — this is the wiring check, not a re-test of the controller.
    $source = file_get_contents(app_path('Http/Controllers/DbLibraryController.php'));

    expect($source)->toContain("config('reserved-routes')");
});

test('username validation refuses every reserved word', function () {
    $source = file_get_contents(app_path('Http/Controllers/AuthController.php'));

    expect($source)->toContain("config('reserved-routes')");
});

test('the admin pages live under a prefix, not at the root', function () {
    // The specific regression: /maintainer was a one-segment root route, so it
    // ate a book name. Pages belong one segment deeper.
    $rootUris = collect(Route::getRoutes())->map(fn ($r) => $r->uri())->all();

    expect($rootUris)->toContain('maintainer/conversion')
        ->and($rootUris)->toContain('maintainer/jobs');
});
