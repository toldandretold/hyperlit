<?php

/**
 * Anti-drift for the whole-book translation map (same pattern as
 * tests/Feature/SourceHarvest/HarvestMapDriftTest.php — the maps are
 * deliberately separate): TranslationMap is the single source the translation
 * live-progress overlay renders from, so its stage ids must always match the
 * `stage: '…'` literals BookTranslationService / TranslateBookJob /
 * BookTranslationController actually record, and its code_refs must always
 * resolve. If this fails you added or renamed a translation stage without
 * updating the map (or vice versa).
 */

use App\Services\Translation\TranslationMap;

test('stage ids match the stage literals the service, job and controller record, in order', function () {
    $emitted = [];
    foreach ([
        app_path('Services/Translation/BookTranslationService.php'),
        app_path('Jobs/TranslateBookJob.php'),
        app_path('Http/Controllers/BookTranslationController.php'),
    ] as $file) {
        preg_match_all("/stage: '([a-z_]+)'/", file_get_contents($file), $m);
        $emitted = array_merge($emitted, $m[1]);
    }
    $emitted = array_values(array_unique($emitted));

    expect(TranslationMap::stageIds())->toBe(['queued', 'text', 'notes', 'write']);
    expect(array_diff($emitted, TranslationMap::stageIds()))->toBe([]);
    expect(array_diff(TranslationMap::stageIds(), $emitted))->toBe([]);
});

test('every code_ref resolves to a real file', function () {
    foreach (TranslationMap::stages() as $stage) {
        expect(file_exists(base_path($stage['code_ref'])))
            ->toBeTrue("code_ref file missing: {$stage['code_ref']}");
    }
});

test('every stage carries the user-facing plain note and a title', function () {
    foreach (TranslationMap::stages() as $stage) {
        expect($stage['title'] ?? '')->not->toBeEmpty();
        expect($stage['plain'] ?? '')->not->toBeEmpty();
        expect($stage['dev'] ?? '')->not->toBeEmpty();
    }
});

test('the map route serves the stages and is not shadowed by the {book} status route', function () {
    // Registered ABOVE /book-translation/{book} in routes/api.php — if route
    // order regresses, `map` is read as a book id and this returns 404.
    $this->getJson('/api/book-translation/map')
        ->assertOk()
        ->assertJsonPath('stages.0.id', 'queued')
        ->assertJsonPath('stages.3.id', 'write');
});
