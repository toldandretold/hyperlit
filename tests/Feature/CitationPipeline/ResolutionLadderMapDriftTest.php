<?php

/**
 * Anti-drift for the resolution ladder map — the same contract PipelineMapDriftTest enforces
 * one level up, for the level below it.
 *
 * ResolutionLadderMap is a DECLARED map, not a derived one, because the waves are inline
 * blocks inside one 1,700-line method and there is no call graph to walk. A declared map is
 * only worth having if something stops it drifting, and this is that something: add or rename
 * a wave without updating the map and the suite goes red.
 *
 * The map is also the vocabulary the per-citation trace records against and the source of the
 * plain-language labels a reader of a citation review sees, so a stale entry here is not a
 * stale diagram — it is a false statement to a reader about how their citation was checked.
 */

use App\Services\CitationPipeline\PipelineMap;
use App\Services\CitationPipeline\ResolutionLadderMap;
use App\Services\WebContent\WebTextAcquirer;

/**
 * The ladder's source is no longer one file. Waves are moving out of `handle()` into their own
 * classes one verified step at a time (see ResolutionWave), so a wave's `Log::info('Wave N: …')`
 * lives either still inline in the job or already in `Resolution/Waves/`. Scanning only the job
 * made this gate fire the moment Wave 2b moved — correctly, since from the job's point of view the
 * wave HAD disappeared, but the answer is that the gate needs to follow it rather than that the
 * extraction is wrong.
 *
 * Concatenating both is deliberate rather than switching over wholesale: during the extraction the
 * ladder genuinely lives in two places, and a gate that assumed either one alone would be blind
 * for the duration.
 */
function ladderJobSource(): string
{
    $sources = [(string) file_get_contents(app_path('Jobs/CitationScanBibliographyJob.php'))];

    $waveDir = app_path('Services/CitationPipeline/Resolution/Waves');
    foreach (glob($waveDir . '/*.php') ?: [] as $file) {
        $sources[] = (string) file_get_contents($file);
    }

    return implode("\n", $sources);
}

test('every wave the job logs is declared in the map', function () {
    preg_match_all("/Log::info\('(Wave [0-9]+(?:\.5)?[ab]?):/", ladderJobSource(), $m);
    $emitted = array_values(array_unique($m[1]));
    sort($emitted);

    $declared = ResolutionLadderMap::waveLogMarkers();
    sort($declared);

    $undeclared = array_values(array_diff($emitted, $declared));
    expect($undeclared)->toBe([], 'the job logs a wave the map does not declare: '
        . implode(', ', $undeclared) . ' — add it to ResolutionLadderMap::waves()');
});

test('every wave the map declares a log marker for is actually emitted', function () {
    preg_match_all("/Log::info\('(Wave [0-9]+(?:\.5)?[ab]?):/", ladderJobSource(), $m);
    $emitted = array_values(array_unique($m[1]));

    $stale = array_values(array_diff(ResolutionLadderMap::waveLogMarkers(), $emitted));
    expect($stale)->toBe([], 'the map declares a wave the job no longer emits: '
        . implode(', ', $stale) . ' — it was renamed or removed');
});

test('every code_ref resolves to a real file, and a real method when one is named', function () {
    foreach (ResolutionLadderMap::allStages() as $stage) {
        [$file, $method] = array_pad(explode('::', $stage['code_ref'], 2), 2, null);

        expect(file_exists(base_path($file)))
            ->toBeTrue("code_ref file missing for '{$stage['id']}': {$file}");

        if ($method) {
            $source = (string) file_get_contents(base_path($file));
            expect(str_contains($source, "function {$method}("))
                ->toBeTrue("code_ref method missing for '{$stage['id']}': {$file}::{$method}");
        }
    }
});

test('every declared grade is a real WebTextAcquirer constant', function () {
    $known = (new ReflectionClass(WebTextAcquirer::class))->getConstants();
    $gradeValues = array_values(array_filter(
        $known,
        fn ($v, $k) => str_starts_with($k, 'GRADE_') && is_string($v),
        ARRAY_FILTER_USE_BOTH
    ));

    $invented = array_values(array_diff(array_keys(ResolutionLadderMap::grades()), $gradeValues));
    expect($invented)->toBe([], 'declared grade(s) that are not GRADE_* constants: '
        . implode(', ', $invented));

    // ...and the other direction: a NEW grade must be described, or the reviewer meets a
    // verdict word the map cannot explain. This is the same rule the web-content gate
    // enforces for describeGrade().
    $undescribed = array_values(array_diff($gradeValues, array_keys(ResolutionLadderMap::grades())));
    expect($undescribed)->toBe([], 'grade(s) with no description in the ladder map: '
        . implode(', ', $undescribed));
});

test('stage ids are unique and non-empty — the trace records against them', function () {
    $ids = ResolutionLadderMap::stageIds();

    expect($ids)->not->toBeEmpty()
        ->and(array_filter($ids, fn ($id) => $id === ''))->toBe([])
        ->and(count($ids))->toBe(count(array_unique($ids)), 'duplicate stage id in the ladder map');
});

test('every stage carries both label registers and its gates', function () {
    // The map feeds a maintainer console AND a reader-facing review. A stage missing its
    // plain label would silently fall back to developer jargon in front of a reader.
    foreach (ResolutionLadderMap::allStages() as $stage) {
        foreach (['id', 'title', 'plain', 'dev', 'code_ref', 'entry_gate', 'accept_gate'] as $key) {
            expect($stage[$key] ?? '')->not->toBe('', "'{$key}' is empty on stage '{$stage['id']}'");
        }
    }
});

test('the ladder map does not restate the verification phases PipelineMap owns', function () {
    // Two sources of truth for one list is how a map starts lying. The review substages
    // belong to PipelineMap; this map covers what happens below its first stage.
    $overlap = array_intersect(ResolutionLadderMap::stageIds(), PipelineMap::reviewSubstageIds());

    expect($overlap)->toBe([], 'these ids exist in BOTH maps: ' . implode(', ', $overlap));
});

// ── The derived half: the wave classes ARE the map ──────────────────────────
// The wave stations are no longer hand-declared — ResolutionLadderMap::waves() reads
// ResolutionLadder::waves(), the same ordered list the job executes. What can still drift is the
// LIST itself (a wave file that exists but was never added to the ladder is silently dead code)
// and each class's own honesty about what it logs and where its edges point.

test('every wave class on disk is in the ladder', function () {
    $onDisk = collect(glob(app_path('Services/CitationPipeline/Resolution/Waves/*.php')))
        ->map(fn ($f) => 'App\\Services\\CitationPipeline\\Resolution\\Waves\\' . basename($f, '.php'))
        ->sort()->values()->all();

    $inLadder = collect(\App\Services\CitationPipeline\Resolution\ResolutionLadder::waves())
        ->map(fn ($w) => get_class($w))
        ->sort()->values()->all();

    expect($inLadder)->toBe($onDisk,
        'a wave class exists on disk but is not in ResolutionLadder::waves() (or vice versa) — '
        . 'a wave not in that list never runs and never appears on the map');
});

test('each wave\'s declared log marker is emitted by its own file, and vice versa', function () {
    foreach (\App\Services\CitationPipeline\Resolution\ResolutionLadder::waves() as $wave) {
        $source = (string) file_get_contents((new ReflectionClass($wave))->getFileName());
        preg_match_all("/Log::info\('(Wave [0-9]+(?:\.5)?[ab]?):/", $source, $m);
        $emitted = array_values(array_unique($m[1]));

        if ($wave->logMarker() !== null) {
            // NOT ->toContain($x, $message): Pest reads extra args as additional NEEDLES.
            expect(in_array($wave->logMarker(), $emitted, true))
                ->toBeTrue(get_class($wave) . " declares '{$wave->logMarker()}' but never logs it");
        }

        // ...and a class quietly logging a marker it does not declare is the same drift reversed.
        $undeclared = array_values(array_diff($emitted, array_filter([$wave->logMarker()])));
        expect($undeclared)->toBe([],
            get_class($wave) . ' logs marker(s) it does not declare: ' . implode(', ', $undeclared));
    }
});

test('no published register carries a wave ordinal', function () {
    // Waves are named for their JOB, never their position (see ResolutionWave) — but the rule
    // was adopted mid-extraction and one class shipped "Wave 2b — OpenAlex DOI lookup" as its
    // TITLE, which the derived map then published straight into the workbench. The ordinal is
    // allowed in exactly one published place: log_marker, which is a label for the operator log,
    // not an identity. Everything else a reader or maintainer sees must survive a reordering.
    foreach (\App\Services\CitationPipeline\Resolution\ResolutionLadder::waves() as $wave) {
        foreach (['title', 'plain', 'dev', 'entryGate', 'acceptGate'] as $register) {
            expect(preg_match('/\bWave \d/i', $wave->{$register}()))
                ->toBe(0, get_class($wave) . "::{$register}() names a wave ordinal — position must not leak into published text");
        }
    }
});

test('every edge points at a real station or a terminal', function () {
    $known = array_merge(
        ResolutionLadderMap::stageIds(),
        ['resolved', 'no_match'],
    );

    foreach (ResolutionLadderMap::edges() as $edge) {
        expect(in_array($edge['from'], $known, true))
            ->toBeTrue("edge FROM unknown station '{$edge['from']}'")
            ->and(in_array($edge['to'], $known, true))
            ->toBeTrue("edge from '{$edge['from']}' TO unknown station '{$edge['to']}' — a dangling edge draws a line to nowhere");
    }
});

test('the ladder order the map publishes is the order the job runs', function () {
    // waves() must be ResolutionLadder-derived, not a re-declared copy: same ids, same order,
    // with only the declared no_match terminal appended.
    $fromLadder = array_map(fn ($w) => $w->id(), \App\Services\CitationPipeline\Resolution\ResolutionLadder::waves());
    $fromMap = array_column(ResolutionLadderMap::waves(), 'id');

    expect($fromMap)->toBe(array_merge($fromLadder, ['no_match']));
});

test('a code_ref becomes a link into the published source', function () {
    $url = ResolutionLadderMap::sourceUrl('app/Services/LlmService.php::validateWebContent');

    expect($url)->toBe('https://github.com/toldandretold/hyperlit/blob/main/app/Services/LlmService.php');
});
