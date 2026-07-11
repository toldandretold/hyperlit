<?php

/**
 * Anti-drift for the Source Network Harvester map (same pattern as
 * tests/Feature/CitationPipeline/PipelineMapDriftTest.php, which covers the
 * citation pipeline's OWN map — the two are deliberately separate): HarvestMap
 * is the single source the harvest live visualisation renders from, so its
 * stage ids must always match the telemetry stages HarvestRunner actually
 * emits, and its code_refs must always resolve. If this fails you added or
 * renamed a harvest stage without updating the map (or vice versa).
 */

use App\Services\SourceHarvest\HarvestMap;

test('stage ids match the telemetry stages HarvestRunner emits, in order', function () {
    $source = file_get_contents(app_path('Services/SourceHarvest/HarvestRunner.php'));
    preg_match_all("/emit\('([a-z_]+)'/", $source, $m);
    $emitted = array_values(array_unique($m[1]));

    expect(HarvestMap::stageIds())->toBe(['scan', 'select', 'harvest', 'shelf']);
    expect(array_diff($emitted, HarvestMap::stageIds()))->toBe([]);
    expect(array_diff(HarvestMap::stageIds(), $emitted))->toBe([]);
});

test('every code_ref resolves to a real file', function () {
    foreach (HarvestMap::stages() as $stage) {
        expect(file_exists(base_path($stage['code_ref'])))
            ->toBeTrue("code_ref file missing: {$stage['code_ref']}");
    }
});

test('every stage carries the user-facing plain note and a title', function () {
    foreach (HarvestMap::stages() as $stage) {
        expect($stage['title'] ?? '')->not->toBeEmpty();
        expect($stage['plain'] ?? '')->not->toBeEmpty();
        expect($stage['dev'] ?? '')->not->toBeEmpty();
    }
});
