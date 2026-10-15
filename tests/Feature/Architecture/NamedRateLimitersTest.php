<?php

/**
 * Rate limiters are NAMED (or prefixed) — never bare `throttle:N,M` (review gate).
 *
 * Laravel's inline throttle keys its hit counter by USER ID (or domain+IP for
 * guests) and NOTHING ELSE — the route is not part of the key. Every
 * inline-throttled route therefore shares ONE counter per user: sixty search
 * requests spend the budget of a `throttle:5,1` route the user never touched.
 * That is how a user's FIRST account-deletion POST 429'd ("Too Many
 * Attempts.") after ordinary SPA sync traffic — the third occurrence of this
 * failure mode (blob-swap and import-progress hit it first, see
 * AppServiceProvider).
 *
 * The fix is one of:
 *   - a NAMED limiter: RateLimiter::for('thing', …) + `throttle:thing`
 *     (the `by()` closure should include a route-distinguishing prefix);
 *   - the inline three-arg form `throttle:N,M,prefix`, whose third argument
 *     scopes the bucket.
 *
 * KNOWN_UNPREFIXED pins the pre-gate debt. Entries there STILL share one
 * bucket with each other — tight limits among them are landmines. Fixing one
 * means REMOVING it here (the test fails on stale entries, so the list only
 * shrinks); adding a new bare throttle fails loudly with this explanation.
 */

use Illuminate\Support\Facades\Route;

function unprefixedInlineThrottles(): array
{
    $found = [];
    foreach (Route::getRoutes() as $route) {
        foreach ($route->gatherMiddleware() as $m) {
            if (is_string($m) && preg_match('/^throttle:\d+,\d+$/', $m)) {
                $found[] = $m.' '.implode('|', $route->methods()).' /'.$route->uri();
            }
        }
    }
    sort($found);

    return array_values(array_unique($found));
}

test('no NEW unprefixed inline throttle middleware (shared-bucket 429s)', function () {
    $known = require __DIR__.'/namedRateLimitersBaseline.php';

    $current = unprefixedInlineThrottles();

    $new = array_diff($current, $known);
    expect(array_values($new))->toBe([],
        'New bare `throttle:N,M` middleware found. Inline throttles share ONE hit counter per user '
        .'across ALL such routes (the route is not in the key) — use a named limiter '
        .'(RateLimiter::for + throttle:name, see AppServiceProvider) or the three-arg form '
        .'`throttle:N,M,prefix`. See CLAUDE.md §"Rate limiters are named".');

    $stale = array_diff($known, $current);
    expect(array_values($stale))->toBe([],
        'Baseline entries no longer in the route table — remove them from '
        .'namedRateLimitersBaseline.php so the debt list only ever shrinks.');
});
