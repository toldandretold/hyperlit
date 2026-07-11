<?php

use App\Services\Tts\SpeakableText;

/**
 * Parity gate: the PHP SpeakableText and its TS port
 * (resources/js/aiProviders/tts/speakableText.ts) must derive the same
 * narration text. Both sides consume the SAME fixture file — change a rule in
 * either implementation and this (or the vitest twin) fails until both agree.
 */
it('matches the shared speakable-text fixtures', function () {
    $path = base_path('tests/javascript/aiProviders/speakableTextFixtures.json');
    $fixtures = json_decode(file_get_contents($path), true);

    expect($fixtures['cases'])->not->toBeEmpty();

    foreach ($fixtures['cases'] as $case) {
        expect(SpeakableText::fromContent($case['content']))
            ->toBe($case['expected'], "fixture case: {$case['name']}");
    }
});
