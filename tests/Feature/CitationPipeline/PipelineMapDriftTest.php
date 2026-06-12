<?php

/**
 * Anti-drift for the citation pipeline map (same pattern as the conversion
 * pipeline's no-drift tests): PipelineMap is the single source the live
 * visualisation renders from, so its stage ids must always match what the
 * code ACTUALLY emits, and its code_refs must always resolve. If this test
 * fails you added/renamed a pipeline stage without updating the map (or vice
 * versa).
 */

use App\Services\CitationPipeline\PipelineMap;

test('top-level stage ids match the steps CitationPipelineCommand emits, in order', function () {
    $source = file_get_contents(app_path('Console/Commands/CitationPipelineCommand.php'));
    preg_match_all("/updatePipelineStep\('([a-z_]+)'/", $source, $m);
    $emitted = array_values(array_unique($m[1]));

    // 'content' (in-text citation scan) merged into the bibliography stage —
    // it is fast and informational, so it shares that stage's tick in the viz.
    expect(PipelineMap::stageIds())->toBe(['bibliography', 'vacuum', 'ocr', 'review']);
    expect(array_diff($emitted, PipelineMap::stageIds()))->toBe([]);
    expect(array_diff(PipelineMap::stageIds(), $emitted))->toBe([]);
});

test('review substage ids match the phase keys CitationReviewService emits', function () {
    $source = file_get_contents(app_path('Services/CitationReviewService.php'));
    preg_match_all("/\\\$progress\('([a-z_]+)'/", $source, $m);
    $emitted = array_values(array_unique($m[1]));

    $mapped = PipelineMap::reviewSubstageIds();

    sort($emitted);
    $sortedMapped = $mapped;
    sort($sortedMapped);

    expect($sortedMapped)->toBe($emitted);
});

test('every code_ref resolves to a real file (and method, when given)', function () {
    $check = function (array $stage) use (&$check) {
        [$file, $method] = array_pad(explode('::', $stage['code_ref'], 2), 2, null);

        expect(file_exists(base_path($file)))->toBeTrue("code_ref file missing: {$file}");
        if ($method) {
            $source = file_get_contents(base_path($file));
            expect(str_contains($source, "function {$method}("))
                ->toBeTrue("code_ref method missing: {$file}::{$method}");
        }

        foreach ($stage['substages'] ?? [] as $sub) {
            $check($sub);
        }
    };

    foreach (PipelineMap::stages() as $stage) {
        $check($stage);
    }
});

test('every stage carries the user-facing plain note and a title', function () {
    $assertNote = function (array $stage) use (&$assertNote) {
        expect($stage['title'] ?? '')->not->toBeEmpty();
        expect($stage['plain'] ?? '')->not->toBeEmpty();
        foreach ($stage['substages'] ?? [] as $sub) {
            $assertNote($sub);
        }
    };

    foreach (PipelineMap::stages() as $stage) {
        $assertNote($stage);
    }
});
