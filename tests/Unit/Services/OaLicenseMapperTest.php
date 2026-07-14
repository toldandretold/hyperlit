<?php

/**
 * OaLicenseMapper — OpenAlex/Unpaywall license slug → the app's library.license
 * vocabulary, so a harvested source shows its real licence (not the site default).
 */

use App\Services\SourceHarvest\OaLicenseMapper;

test('maps exact CC slugs to the library vocabulary', function () {
    expect(OaLicenseMapper::toLibraryLicense('cc-by')['license'])->toBe('CC-BY-4.0');
    expect(OaLicenseMapper::toLibraryLicense('cc-by-nc-sa')['license'])->toBe('CC-BY-NC-SA-4.0');
    expect(OaLicenseMapper::toLibraryLicense('cc-by-nc-nd')['license'])->toBe('CC-BY-NC-ND-4.0');
    expect(OaLicenseMapper::toLibraryLicense('cc0')['license'])->toBe('CC0');
    expect(OaLicenseMapper::toLibraryLicense('public-domain')['license'])->toBe('CC0');
});

test('normalises case and a trailing version suffix', function () {
    expect(OaLicenseMapper::toLibraryLicense('CC-BY-4.0')['license'])->toBe('CC-BY-4.0');
    expect(OaLicenseMapper::toLibraryLicense('CC-BY-SA')['license'])->toBe('CC-BY-SA-4.0');
});

test('a null/empty license is decided by OA status', function () {
    // Bronze/closed: free-to-read at most, no reuse rights.
    expect(OaLicenseMapper::toLibraryLicense(null, 'bronze')['license'])->toBe('All-Rights-Reserved');
    expect(OaLicenseMapper::toLibraryLicense(null, 'closed')['license'])->toBe('All-Rights-Reserved');
    expect(OaLicenseMapper::toLibraryLicense('', null)['license'])->toBe('All-Rights-Reserved');
    // Genuinely open but no license slug recorded = open, unspecified.
    expect(OaLicenseMapper::toLibraryLicense(null, 'gold')['license'])->toBe('Open-Unspecified');
    expect(OaLicenseMapper::toLibraryLicense(null, 'green')['license'])->toBe('Open-Unspecified');
});

test('publisher-specific and other-oa map to their labels', function () {
    expect(OaLicenseMapper::toLibraryLicense('publisher-specific-oa')['license'])->toBe('Publisher-Open');
    expect(OaLicenseMapper::toLibraryLicense('other-oa')['license'])->toBe('Open-Unspecified');
});

test('an unrecognised slug falls back to custom + custom_license_text', function () {
    $r = OaLicenseMapper::toLibraryLicense('mit-weirdo-license');
    expect($r['license'])->toBe('custom');
    expect($r['custom_license_text'])->toBe('MIT WEIRDO LICENSE');
});
