<?php

/**
 * The journal and shelf import consoles are ONE console over two scopes (review gate).
 *
 * /maintainer/journal-import/{slug} and /maintainer/shelf-import/{id} share a script, a
 * stylesheet, a job and a run table — and still drifted, because for three months everything
 * built on top was added to the journal side only and made to switch itself OFF on the shelf:
 * the run panel was markup in one blade, the drain count and the lint were private methods of
 * one controller, and the script returned early on `boot.shelfId`. The shelf console ended up
 * running a reconvert-all over hundreds of books with no progress, no drain view, no way to
 * re-attach after a reload and nothing to stop a second press.
 *
 * The fix was structural, and this holds the structure in place:
 *   - shared markup is a PARTIAL both pages include, never a copy in each;
 *   - scope-keyed queries live in App\Services\Conversion\ImportConsoleScope, never privately
 *     in one controller;
 *   - a scope-keyed endpoint exists for BOTH scopes unless it is listed here as belonging to
 *     one of them, with the reason;
 *   - the script never switches a feature off by scope.
 *
 * Source-level on purpose: the failure is a divergence between two files, which a rendered page
 * of either one cannot show.
 */

use Illuminate\Support\Facades\Route;

const IMPORT_CONSOLE_PARTIALS = ['columns', 'action-bars', 'run-panel'];

function importConsoleScopedRoutes(string $prefix, string $param): array
{
    $out = [];
    foreach (Route::getRoutes() as $route) {
        $uri = $route->uri();
        $head = "api/maintainer/{$prefix}/{{$param}}/";
        if (! str_starts_with($uri, $head)) {
            continue;
        }
        foreach (array_diff($route->methods(), ['HEAD']) as $method) {
            $out[] = $method . ' ' . substr($uri, strlen($head));
        }
    }
    sort($out);

    return $out;
}

test('both detail pages are assembled from the same partials', function () {
    $pages = [
        'journal' => file_get_contents(resource_path('views/maintainer-journal-import-detail.blade.php')),
        'shelf'   => file_get_contents(resource_path('views/maintainer-shelf-import.blade.php')),
    ];

    foreach ($pages as $name => $blade) {
        foreach (IMPORT_CONSOLE_PARTIALS as $partial) {
            expect(str_contains($blade, "@include('partials.maintainer.import-console.{$partial}'"))->toBeTrue(
                "The {$name} import console no longer includes partials/maintainer/import-console/{$partial}.blade.php. "
                . 'That markup is shared by both consoles — include it, do not copy it into the page.');
        }
    }
});

test('an element id declared in a shared partial is not redeclared in either page', function () {
    $ids = [];
    foreach (IMPORT_CONSOLE_PARTIALS as $partial) {
        $source = file_get_contents(resource_path("views/partials/maintainer/import-console/{$partial}.blade.php"));
        preg_match_all('/\bid="(ji-[a-z0-9-]+)"/', $source, $m);
        $ids = array_merge($ids, $m[1]);
    }
    // Not vacuous: the panels whose absence from the shelf page was the whole bug.
    expect($ids)->toContain('ji-run-panel', 'ji-run-bar-fill', 'ji-failures', 'ji-lint-bar', 'ji-only-problems', 'ji-findings');

    $copied = [];
    foreach (['maintainer-journal-import-detail', 'maintainer-shelf-import'] as $page) {
        $blade = file_get_contents(resource_path("views/{$page}.blade.php"));
        foreach (array_unique($ids) as $id) {
            if (str_contains($blade, "id=\"{$id}\"")) {
                $copied[] = "{$page}: #{$id}";
            }
        }
    }

    expect($copied)->toBe([],
        'A page blade declares an element that already lives in a shared import-console partial. '
        . 'A second copy is how the two consoles drifted apart — edit the partial instead.');
});

test('both pages carry the scope-wide reconvert controls the script wires', function () {
    foreach (['maintainer-journal-import-detail', 'maintainer-shelf-import'] as $page) {
        $blade = file_get_contents(resource_path("views/{$page}.blade.php"));
        foreach (['ji-reconvert-all', 'ji-bulk-lanes', 'ji-journal-status'] as $id) {
            expect(str_contains($blade, "id=\"{$id}\""))->toBeTrue("{$page} is missing #{$id}.");
        }
    }
});

test('scope-keyed queries live in ImportConsoleScope, not in a controller', function () {
    $owned = ['pendingConversionJobs', 'lintableBooks', 'activeRun'];

    foreach (['JournalImportController', 'ShelfImportController'] as $controller) {
        $source = file_get_contents(app_path("Http/Controllers/Maintainer/{$controller}.php"));

        foreach ($owned as $method) {
            expect(preg_match('/function\s+' . $method . '\s*\(/', $source))->toBe(0,
                "{$controller} declares its own {$method}(). That question is answered once, for both "
                . 'consoles, by App\Services\Conversion\ImportConsoleScope — a private copy here is a '
                . 'feature the other console silently does not have.');
        }
        foreach (['BuildsImportLanes', 'ServesConversionLint'] as $trait) {
            expect(preg_match('/^\s+use ' . $trait . ';/m', $source))->toBe(1,
                "{$controller} no longer uses the shared {$trait} trait.");
        }
        // The run table is written in one place (BuildsImportLanes::startRun).
        expect(str_contains($source, "table('journal_import_runs')->insert"))->toBeFalse(
            "{$controller} inserts into journal_import_runs itself — start runs through startRun().");
    }
});

test('every scope-keyed endpoint exists for both scopes, or is declared as one scope\'s own', function () {
    $journal = importConsoleScopedRoutes('journal-import', 'slug');
    $shelf   = importConsoleScopedRoutes('shelf-import', 'id');

    // What only one console has, and why. Adding to these lists is a decision, not a default.
    $journalOnly = [
        'POST certify',     // vouches for the JOURNAL on the homepage (journal_sources.certified_at)
        'POST hero-name',   // the journal's /j page hero override
    ];
    $shelfOnly = [
        'GET archive',      // the shelf's /a/{slug} archive page record
        'POST archive',
    ];

    expect(array_values(array_diff($journal, $shelf, $journalOnly)))->toBe([],
        'A journal-import endpoint has no shelf-import twin. If it is keyed by the SCOPE (anything about '
        . '"the books this console is working"), serve it for both from the shared traits; if it is '
        . 'genuinely about journals, add it to $journalOnly here with the reason.');
    expect(array_values(array_diff($shelf, $journal, $shelfOnly)))->toBe([],
        'A shelf-import endpoint has no journal-import twin — same rule, the other way round.');

    // Not vacuous, and the ones that were missing are really there now.
    expect($shelf)->toContain('GET reconvert-backlog', 'GET lint', 'POST lint/snapshot', 'POST run', 'GET articles');
});

test('the console script never switches a feature off by scope', function () {
    $source = file_get_contents(resource_path('js/workbenches/journalImport/main.ts'))
        . file_get_contents(resource_path('js/workbenches/journalImport/lintPanel.ts'));

    // One line at a time: `if (boot.shelfId) return;` and `if (boot.shelfId || !el) return;`.
    preg_match_all('/^[ \t]*if\s*\(\s*boot\.(?:shelfId|mode)\b.*\)\s*return\b.*$/m', $source, $m);

    expect($m[0])->toBe([],
        'The import console script returns early for one scope. Every scope-keyed endpoint exists '
        . 'under both API bases (apiBase()), so there is nothing to switch off — tolerate a missing '
        . 'ELEMENT if the two headers differ, never a missing scope.');
});
