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

test('an assumed 4.0 only ever loses its version — never changes family, never drops a version the hosted copy stated', function () {
    $base = ['creator' => 'canonicalizer_v1'];
    remapSeed('remap_assumed', $base + ['license' => 'CC-BY-NC-ND-4.0', 'work_license' => 'cc-by-nc-nd']);
    // Stored family disagrees with work_license: the code came from elsewhere (won copy outranks it).
    remapSeed('remap_otherfam', $base + ['license' => 'CC-BY-NC-SA-4.0', 'work_license' => 'cc-by-nc-nd']);
    remapSeed('remap_vague', $base + ['license' => 'CC-BY-NC-ND-4.0', 'work_license' => 'other-oa', 'oa_status' => 'gold']);
    // The copy we host recorded a real 4.0.
    remapSeed('remap_won', $base + ['license' => 'CC-BY-4.0', 'work_license' => 'cc-by', 'has_nodes' => true]);
    $dir = resource_path('markdown/remap_won');
    @mkdir($dir, 0777, true);
    file_put_contents("{$dir}/fetch_trace.json", json_encode(['won_license' => 'https://creativecommons.org/licenses/by/4.0/']));

    try {
        $this->artisan('library:remap-licenses', ['--book' => ['remap_assumed', 'remap_otherfam', 'remap_vague', 'remap_won'], '--apply' => true])
            ->assertSuccessful();
    } finally {
        @unlink("{$dir}/fetch_trace.json");
        @rmdir($dir);
    }

    expect(remapLicense('remap_assumed')['license'])->toBe('CC-BY-NC-ND');
    expect(remapLicense('remap_otherfam')['license'])->toBe('CC-BY-NC-SA-4.0');
    expect(remapLicense('remap_vague')['license'])->toBe('CC-BY-NC-ND-4.0');
    expect(remapLicense('remap_won')['license'])->toBe('CC-BY-4.0');
});
