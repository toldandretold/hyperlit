<?php

/**
 * The /maintainer index lists EVERY workbench.
 *
 * The workbenches were built one at a time and five of ten were linked from
 * nowhere, which is how they got forgotten. config/workbenches.php is the one
 * list; this fails when a new parameterless /maintainer page is not on it, or
 * when an entry points at a route that no longer exists.
 */

use Illuminate\Support\Facades\Route;

/** @return list<string> every url in config/workbenches.php */
function listedWorkbenchUrls(): array
{
    $urls = [];
    foreach (config('workbenches') as $tools) {
        foreach ($tools as $tool) {
            $urls[] = $tool['url'];
        }
    }

    return $urls;
}

test('every parameterless /maintainer page is listed in config/workbenches.php', function () {
    $pages = [];
    foreach (Route::getRoutes() as $route) {
        $uri = $route->uri();
        if (in_array('GET', $route->methods(), true)
            && str_starts_with($uri, 'maintainer/')
            && ! str_contains($uri, '{')) {
            $pages[] = '/'.$uri;
        }
    }

    expect(array_values(array_diff($pages, listedWorkbenchUrls())))->toBe([],
        'A /maintainer page is missing from config/workbenches.php — add it, or it will be forgotten.');
});

test('every listed workbench points at a real route', function () {
    $routes = [];
    foreach (Route::getRoutes() as $route) {
        $routes[] = '/'.$route->uri();
    }

    expect(array_values(array_diff(listedWorkbenchUrls(), $routes)))->toBe([]);
});

test('the index renders every workbench for an admin, and 404s for everyone else', function () {
    $this->get('/maintainer')->assertNotFound();

    $this->loginUser();
    $this->get('/maintainer')->assertNotFound();

    $this->loginUser(['is_admin' => true]);
    $response = $this->get('/maintainer')->assertOk()->assertViewIs('maintainer-index');
    foreach (listedWorkbenchUrls() as $url) {
        $response->assertSee('href="'.$url.'"', false);
    }
});
