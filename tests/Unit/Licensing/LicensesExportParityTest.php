<?php

/**
 * The front end's licence map is GENERATED from App\Support\Licenses. If this fails, run
 * `php artisan licenses:export-js` and commit the regenerated file.
 *
 * Why it is a gate: the vocabulary used to live only in a hand-written TS map while the server
 * accepted any string, and every code the map lacked was shown to readers as Hyperlit's own
 * CC BY-SA No-AI licence.
 */

use App\Console\Commands\LicensesExportJsCommand;
use App\Support\Licenses;

test('the committed licenses.generated.ts matches App\\Support\\Licenses', function () {
    // Unit suite: no app container, so resolve from the repo root directly.
    $path = dirname(__DIR__, 3) . '/' . LicensesExportJsCommand::PATH;
    expect(is_file($path))->toBeTrue();
    expect(file_get_contents($path))->toBe(LicensesExportJsCommand::render());
});

test('every legacy code already stored in library rows is still in the vocabulary', function () {
    foreach (['CC-BY-SA-4.0-NO-AI', 'CC-BY-4.0', 'CC-BY-NC-SA-4.0', 'CC0', 'All-Rights-Reserved', 'custom',
        'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'CC-BY-NC-ND-4.0', 'Publisher-Open', 'Open-Unspecified'] as $code) {
        expect(Licenses::isValid($code))->toBeTrue("{$code} must stay valid — it is stored in existing rows");
    }
});

test('an unknown code labels as unknown, never as the site default', function () {
    expect(Licenses::info('MIT')['label'])->toBe('Licence unknown');
    expect(Licenses::info(null)['label'])->toBe('Licence unknown');
});
