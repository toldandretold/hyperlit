<?php

/**
 * OaLicenseMapper — upstream licence strings → the App\Support\Licenses vocabulary, so a
 * harvested/imported work shows its REAL licence (not the site default).
 *
 * The "real strings" cases are verbatim values found in library.work_license /
 * custom_license_text: before the rewrite every one of them fell to `custom` with the text
 * SHOUTED, while a correct licence was right there in the string.
 */

use App\Services\SourceHarvest\OaLicenseMapper;
use App\Support\Licenses;

$code = fn (?string $raw, ?string $status = null) => OaLicenseMapper::toLibraryLicense($raw, $status)['license'];

test('maps bare OpenAlex CC slugs, defaulting the version to 4.0', function () use ($code) {
    expect($code('cc-by'))->toBe('CC-BY-4.0');
    expect($code('cc-by-sa'))->toBe('CC-BY-SA-4.0');
    expect($code('cc-by-nc'))->toBe('CC-BY-NC-4.0');
    expect($code('cc-by-nd'))->toBe('CC-BY-ND-4.0');
    expect($code('cc-by-nc-sa'))->toBe('CC-BY-NC-SA-4.0');
    expect($code('cc-by-nc-nd'))->toBe('CC-BY-NC-ND-4.0');
    expect($code('cc0'))->toBe('CC0');
});

test('keeps the version a string actually carries instead of flattening to 4.0', function () use ($code) {
    expect($code('cc-by-3.0'))->toBe('CC-BY-3.0');
    expect($code('CC-BY-NC-SA-2.0'))->toBe('CC-BY-NC-SA-2.0');
    expect($code('https://creativecommons.org/licenses/by/2.5/'))->toBe('CC-BY-2.5');
});

test('reads Creative Commons URLs in every shape seen upstream', function () use ($code) {
    expect($code('https://creativecommons.org/licenses/by-nc-nd/4.0/'))->toBe('CC-BY-NC-ND-4.0');
    expect($code('HTTPS://CREATIVECOMMONS.ORG/LICENSES/BY NC ND/4.0/'))->toBe('CC-BY-NC-ND-4.0');
    expect($code('http://creativecommons.org/licenses/by/4.0/deed.no'))->toBe('CC-BY-4.0');
    expect($code('http://creativecommons.org/licenses/by-nc-nd'))->toBe('CC-BY-NC-ND-4.0');
    expect($code('https://creativecommons.org/licenses/by'))->toBe('CC-BY-4.0');
    expect($code('https://creativecommons.org/licenses/by-sa/4.0/legalcode'))->toBe('CC-BY-SA-4.0');
    expect($code('https://creativecommons.org/publicdomain/zero/1.0/'))->toBe('CC0');
    expect($code('https://creativecommons.org/publicdomain/mark/1.0/'))->toBe('PDM');
});

test('reads underscored, spaced and spelled-out CC names', function () use ($code) {
    expect($code('CC_BY'))->toBe('CC-BY-4.0');
    expect($code('CC BY NC'))->toBe('CC-BY-NC-4.0');
    expect($code('CC BY 4.0'))->toBe('CC-BY-4.0');
    expect($code('Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International'))->toBe('CC-BY-NC-SA-4.0');
    expect($code('cc-by-sa-nc'))->toBe('CC-BY-NC-SA-4.0'); // order-insensitive
});

test('public domain is the Public Domain Mark, not a CC0 dedication', function () use ($code) {
    expect($code('public-domain'))->toBe('PDM');
    expect($code('pd'))->toBe('PDM');
    expect($code('Public domain in the USA.'))->toBe('PDM'); // Project Gutenberg dcterms:rights
});

test('accepts an already-canonical stored code in any casing', function () use ($code) {
    expect($code('all-rights-reserved'))->toBe('All-Rights-Reserved');
    expect($code('cc-by-sa-4.0'))->toBe('CC-BY-SA-4.0');
    expect($code('CC-BY-SA-4.0-NO-AI'))->toBe('CC-BY-SA-4.0-NO-AI');
});

test('a null/empty licence is decided by OA status', function () use ($code) {
    expect($code(null, 'bronze'))->toBe('All-Rights-Reserved');
    expect($code(null, 'closed'))->toBe('All-Rights-Reserved');
    expect($code('', null))->toBe('All-Rights-Reserved');
    expect($code(null, 'gold'))->toBe('Open-Unspecified');
    expect($code(null, 'diamond'))->toBe('Open-Unspecified');
});

test('non-CC open-access labels', function () use ($code) {
    expect($code('publisher-specific-oa'))->toBe('Publisher-Open');
    expect($code('other-oa'))->toBe('Open-Unspecified');
    expect($code('info:eu-repo/semantics/openAccess'))->toBe('Open-Unspecified');
});

test('impossible CC combinations are not invented', function () {
    expect(OaLicenseMapper::parse('cc-by-sa-nd'))->toBeNull();
    expect(OaLicenseMapper::parse('cc-nc'))->toBeNull();
});

test('an unrecognised string becomes custom with its ORIGINAL wording, linked when it is a URL', function () {
    $r = OaLicenseMapper::toLibraryLicense('https://umlib.nl/taverne-license');
    expect($r['license'])->toBe('custom');
    expect($r['custom_license_text'])->toBe('https://umlib.nl/taverne-license');
    expect($r['license_url'])->toBe('https://umlib.nl/taverne-license');

    $r = OaLicenseMapper::toLibraryLicense('mit-weirdo-license');
    expect($r['license'])->toBe('custom');
    expect($r['custom_license_text'])->toBe('mit-weirdo-license');
    expect($r['license_url'])->toBeNull();
});

test('a bare copyright notice is not a licence (parse yields nothing, so a fallback can win)', function () {
    expect(OaLicenseMapper::parse('© 2023 The Authors'))->toBeNull();
});

test('every code the mapper can emit is in the vocabulary', function () {
    $inputs = ['cc-by', 'cc-by-3.0', 'cc0', 'pd', 'other-oa', 'publisher-specific-oa', 'all rights reserved', 'x', null];
    foreach ($inputs as $in) {
        expect(Licenses::isValid(OaLicenseMapper::toLibraryLicense($in, 'gold')['license']))->toBeTrue();
    }
});
