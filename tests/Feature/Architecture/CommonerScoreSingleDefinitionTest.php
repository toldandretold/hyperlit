<?php

/**
 * ONE definition of the commoner score ("hectares tilled").
 *
 * Mirrors ConnectionScoreSingleDefinitionTest: the score's formula and its
 * recompute SQL live only in App\Services\Commoner\CommonerScoreService, and
 * every recompute reacting to a sync-internal write defers past the wrapping
 * transaction (the 2026-08-30 cross-connection deadlock guard).
 */

/** Every .php file under app/, as path => contents. */
function commonerGateSources(): array
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

test('the hectares weights live only in CommonerScoreService', function () {
    $offenders = [];
    foreach (commonerGateSources() as $path => $source) {
        if ($path === 'app/Services/Commoner/CommonerScoreService.php') {
            continue;
        }
        if (preg_match('/[A-Z_]+_HECTARES\b|CommonerScoreService::SOURCES/', $source)) {
            $offenders[] = $path;
        }
    }

    expect($offenders)->toBe([], 'The score weights are defined once in CommonerScoreService — do not re-derive the formula: '.implode(', ', $offenders));
});

test('nothing writes users.commoner_score except the service', function () {
    // A SET of the column — the recompute. breakdownFor only READS; callers use
    // the service, never an inline UPDATE. User.php is allowed for the Eloquent
    // fillable/cast MAPPING (same precedent as PgLibrary in the connection gate).
    $allowed = [
        'app/Services/Commoner/CommonerScoreService.php',
        'app/Models/User.php',
    ];

    $offenders = [];
    foreach (commonerGateSources() as $path => $source) {
        if (in_array($path, $allowed, true)) {
            continue;
        }
        // An actual UPDATE of the column (bare SQL `commoner_score = ` — not the
        // `'commoner_score' =>` cast arrow, which only the model carries).
        if (preg_match('/commoner_score\s*=[^>=]/', $source)) {
            $offenders[] = $path;
        }
    }

    expect($offenders)->toBe([], 'users.commoner_score is written only by CommonerScoreService::recompute: '.implode(', ', $offenders));
});

test('sync-internal commoner recomputes defer past the wrapping transaction', function () {
    // DbHyperlightController's resolve/delete run (resolve is a direct route,
    // delete can ride unified-sync) and the recompute writes users via
    // pgsql_admin — a second connection that would deadlock against an open
    // default-connection transaction. Every CommonerScoreService::recompute
    // call in a sync-internal controller must be on an afterCommit line.
    $syncInternal = [
        'app/Http/Controllers/DbHyperlightController.php',
    ];

    $offenders = [];
    foreach ($syncInternal as $path) {
        $source = file_get_contents(base_path($path));
        foreach (preg_split('/\R/', $source) as $n => $line) {
            if (str_contains($line, '->recompute(') && str_contains($line, 'CommonerScoreService')
                && ! str_contains($line, 'afterCommit')) {
                $offenders[] = $path.':'.($n + 1);
            }
        }
    }

    expect($offenders)->toBe([], 'A commoner recompute reacting to a sync write must be DB::afterCommit (deadlock guard): '.implode(', ', $offenders));
});
