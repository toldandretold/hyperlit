<?php

/**
 * library:remap-licenses — repairs third-party works mislabelled with the site default, and
 * leaves a user's own books alone.
 */

use Illuminate\Support\Facades\DB;

afterEach(function () {
    DB::connection('pgsql_admin')->table('library')->where('book', 'like', 'remap_%')->delete();
});

function remapSeed(string $book, array $attrs): void
{
    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book, 'title' => $book, 'visibility' => 'public',
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ], $attrs));
}

function remapLicense(string $book): array
{
    return (array) DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->first(['license', 'custom_license_text']);
}

test('dry run changes nothing; --apply repairs harvested rows and keeps user books', function () {
    remapSeed('remap_harvest', ['creator' => 'canonicalizer_v1', 'work_license' => 'cc-by-nc-nd', 'oa_status' => 'gold']);
    remapSeed('remap_shout', ['creator' => 'canonicalizer_v1', 'license' => 'custom', 'custom_license_text' => 'HTTPS://CREATIVECOMMONS.ORG/LICENSES/BY NC/4.0/']);
    remapSeed('remap_gutenberg', ['creator' => 'someone', 'work_license' => 'Public domain in the USA.',
        'raw_json' => json_encode(['imported_via' => 'url'])]);
    remapSeed('remap_user', ['creator' => 'someone']); // their own writing, default licence
    remapSeed('remap_case', ['creator' => 'someone', 'license' => 'all-rights-reserved']);

    $only = ['--book' => ['remap_harvest', 'remap_shout', 'remap_gutenberg', 'remap_user', 'remap_case']];

    $this->artisan('library:remap-licenses', $only)->assertSuccessful();
    expect(remapLicense('remap_harvest')['license'])->toBe('CC-BY-SA-4.0-NO-AI');

    $this->artisan('library:remap-licenses', $only + ['--apply' => true])->assertSuccessful();
    expect(remapLicense('remap_harvest')['license'])->toBe('CC-BY-NC-ND'); // slug carries no version
    expect(remapLicense('remap_shout'))->toBe(['license' => 'CC-BY-NC-4.0', 'custom_license_text' => null]);
    expect(remapLicense('remap_gutenberg')['license'])->toBe('PDM');
    expect(remapLicense('remap_user')['license'])->toBe('CC-BY-SA-4.0-NO-AI');
    expect(remapLicense('remap_case')['license'])->toBe('All-Rights-Reserved');
});
