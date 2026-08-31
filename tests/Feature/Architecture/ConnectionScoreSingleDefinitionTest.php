<?php

/**
 * ONE definition of "how connected is this text".
 *
 * This gate exists because the bug it replaced was a fragmentation bug, not a
 * maths bug. "Most Connected" was implemented FOUR times (ShelfController
 * render + publicRender, UserHomeServerController renderSorted +
 * publicRenderSorted) reading a column that was computed THREE times
 * (HomePageServerController::countCitationsForBook, DbLibraryController's
 * updateTotalCitesColumnInternal and updateBookStats), each with its own
 * inlined self-citation check. Nothing kept them honest, so the column drifted
 * into meaning "inbound hypercites, for `listed = true` books only" while the
 * feeds still called it connectedness — and the journal corpus, minted
 * `listed = false`, was NULL forever.
 *
 * If you are adding a new feed that ranks by connectedness, call
 * ConnectionCountQuery — do not re-derive it locally.
 */

use App\Services\Connections\ConnectionCountQuery;

/** Every .php file under app/, as path => contents. */
function connGateSources(): array
{
    $root = base_path('app');
    $files = [];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $file) {
        if ($file->isFile() && $file->getExtension() === 'php') {
            $files[str_replace(base_path().'/', '', $file->getPathname())] = file_get_contents($file->getPathname());
        }
    }
    ksort($files);

    return $files;
}

test('nothing ranks on total_citations any more', function () {
    // The superseded column. It counted INBOUND hypercites only — a text citing
    // a hundred others scored zero — and only `listed = true` books were ever
    // recomputed. Its readers are now hypercite_connections /
    // reference_connections. PgLibrary keeps the attribute mapping because the
    // column still physically exists.
    $allowed = [
        'app/Models/PgLibrary.php',
        'app/Services/Connections/ConnectionCountQuery.php',
    ];

    $offenders = [];
    foreach (connGateSources() as $path => $source) {
        if (in_array($path, $allowed, true)) {
            continue;
        }
        if (str_contains($source, 'total_citations')) {
            $offenders[] = $path;
        }
    }

    expect($offenders)->toBe([], 'Rank on hypercite_connections / reference_connections via ConnectionCountQuery, not total_citations: '.implode(', ', $offenders));
});

test('every connected/lit sort arm delegates to ConnectionCountQuery', function () {
    $sites = [];
    foreach (connGateSources() as $path => $source) {
        // A feed SORT arm: "'connected' => …sort…" in a match block. The
        // sort-verb requirement keeps unrelated array keys out (e.g.
        // JournalPageController's hypercite-map modes are keyed
        // 'all'/'connected' but sort nothing).
        foreach (preg_split('/\R/', $source) as $line) {
            if (preg_match("/'(connected|lit)'\s*=>/", $line) && preg_match('/sort/i', $line)) {
                $sites[$path] = $source;
                break;
            }
        }
    }

    // The four known feeds. A new entry here is fine — it just has to delegate.
    expect(array_keys($sites))->toBe([
        'app/Http/Controllers/ShelfController.php',
        'app/Http/Controllers/UserHomeServerController.php',
    ]);

    $undelegated = [];
    foreach ($sites as $path => $source) {
        if (! str_contains($source, 'ConnectionCountQuery::sortConnected')
            || ! str_contains($source, 'ConnectionCountQuery::sortLit')) {
            $undelegated[] = $path;
        }
    }

    expect($undelegated)->toBe([], 'These sort a connected/lit feed without delegating: '.implode(', ', $undelegated));
});

test('the homepage feeds delegate their ranking to ConnectionCountQuery', function () {
    // The homepage used to rank with its own usort over a composite metric —
    // same intent as sortConnected/sortLit, separate code, so a weight change
    // in the one definition silently skipped the busiest page. It now calls
    // the service's sorts directly (no match arm, hence not caught above).
    $source = file_get_contents(base_path('app/Http/Controllers/HomePageServerController.php'));

    expect($source)->toContain('ConnectionCountQuery::sortConnected');
    expect($source)->toContain('ConnectionCountQuery::sortLit');
    expect(str_contains($source, 'usort'))->toBeFalse('HomePageServerController must not re-implement ranking with usort — delegate to ConnectionCountQuery.');
});

test('no second self-citation rule', function () {
    // The old isSelfCitation() only caught a book citing ITSELF, so a user
    // ring-citing their own OTHER books scored in full — and `library.listed`
    // defaults to true, so those books reach the homepage ranking unreviewed.
    // The replacement (self-loop AND same-real-owner, after sub-book rollup)
    // lives in the SQL in ConnectionCountQuery.
    $offenders = [];
    foreach (connGateSources() as $path => $source) {
        if (str_contains($source, 'function isSelfCitation')) {
            $offenders[] = $path;
        }
    }

    expect($offenders)->toBe([]);
});

test('sync-internal edge refreshes defer past the wrapping transaction', function () {
    // UnifiedSyncController wraps the whole sync in DB::transaction and calls
    // these controllers' upserts INSIDE it. ConnectionRefresher's recompute
    // writes `library` via pgsql_admin — a second connection that blocks
    // forever on rows the open default-connection transaction has locked
    // (updateAnnotationsTimestamp / the library upsert touch the same rows).
    // Inline, the request deadlocks against itself and wedges the whole FPM
    // pool (2026-08-30: 1h36m site outage mid-e2e). Every refresh in a
    // sync-internal controller must be deferred with DB::afterCommit, which
    // runs immediately when no transaction is open (direct route hits).
    $syncInternal = [
        'app/Http/Controllers/DbNodeController.php',
        'app/Http/Controllers/DbHyperciteController.php',
        'app/Http/Controllers/DbHyperlightController.php',
        'app/Http/Controllers/DbFootnoteController.php',
        'app/Http/Controllers/DbReferencesController.php',
        'app/Http/Controllers/DbLibraryController.php',
    ];

    $offenders = [];
    foreach ($syncInternal as $path) {
        $source = file_get_contents(base_path($path));
        foreach (preg_split('/\R/', $source) as $n => $line) {
            if (preg_match('/ConnectionRefresher(::class\))?->refresh\(|ConnectionRefresher\)->refresh\(/', $line)
                && ! str_contains($line, 'afterCommit')) {
                $offenders[] = $path.':'.($n + 1);
            }
        }
    }

    expect($offenders)->toBe([], 'Wrap these refresh calls in DB::afterCommit(fn () => …) — they can run inside the unified-sync transaction and deadlock cross-connection: '.implode(', ', $offenders));
});

test('the ranking weights are declared, not scattered', function () {
    // Weighting is a policy knob (inbound is worth more because it is the one
    // direction you cannot self-inflate). Keeping it on the service means
    // changing it is one edit plus a recompute.
    expect(ConnectionCountQuery::INBOUND_WEIGHT)->toBeGreaterThan(ConnectionCountQuery::OUTBOUND_WEIGHT);
    expect(ConnectionCountQuery::score(1, 0))->toBe(ConnectionCountQuery::INBOUND_WEIGHT);
    expect(ConnectionCountQuery::score(0, 1))->toBe(ConnectionCountQuery::OUTBOUND_WEIGHT);
});
