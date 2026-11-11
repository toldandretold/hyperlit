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

test('a bare OpenAlex CC slug maps to its version-less family, never an assumed 4.0', function () use ($code) {
    // OpenAlex/Unpaywall say "cc-by" — the family, not the version. Printing "CC BY 4.0" for
    // a CC BY 3.0 article would be a claim we were never told.
    expect($code('cc-by'))->toBe('CC-BY');
    expect($code('cc-by-sa'))->toBe('CC-BY-SA');
    expect($code('cc-by-nc'))->toBe('CC-BY-NC');
    expect($code('cc-by-nd'))->toBe('CC-BY-ND');
    expect($code('cc-by-nc-sa'))->toBe('CC-BY-NC-SA');
    expect($code('cc-by-nc-nd'))->toBe('CC-BY-NC-ND');
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
    expect($code('http://creativecommons.org/licenses/by-nc-nd'))->toBe('CC-BY-NC-ND'); // no version in the URL
    expect($code('https://creativecommons.org/licenses/by'))->toBe('CC-BY');
    expect($code('https://creativecommons.org/licenses/by-sa/4.0/legalcode'))->toBe('CC-BY-SA-4.0');
    expect($code('https://creativecommons.org/publicdomain/zero/1.0/'))->toBe('CC0');
    expect($code('https://creativecommons.org/publicdomain/mark/1.0/'))->toBe('PDM');
});

test('reads underscored, spaced and spelled-out CC names', function () use ($code) {
    expect($code('CC_BY'))->toBe('CC-BY');
    expect($code('CC BY NC'))->toBe('CC-BY-NC');
    expect($code('CC BY 4.0'))->toBe('CC-BY-4.0');
    expect($code('Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International'))->toBe('CC-BY-NC-SA-4.0');
    expect($code('cc-by-sa-nc'))->toBe('CC-BY-NC-SA'); // order-insensitive
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

test('arXiv\'s own licences map to arXiv-Nonexclusive, keeping the link', function () {
    $r = OaLicenseMapper::parse('http://arxiv.org/licenses/nonexclusive-distrib/1.0/');
    expect($r['license'])->toBe(Licenses::ARXIV_NONEXCLUSIVE);
    expect($r['license_url'])->toBe('http://arxiv.org/licenses/nonexclusive-distrib/1.0/');
    expect(OaLicenseMapper::parse('http://arxiv.org/licenses/assumed-1991-2003/')['license'])->toBe(Licenses::ARXIV_NONEXCLUSIVE);
});

test('publisher standard-terms URLs (Crossref license[]) read as all rights reserved, with the link', function () {
    foreach ([
        'https://www.elsevier.com/tdm/userlicense/1.0/',
        'http://www.springer.com/tdm',
        'https://www.springernature.com/gp/researchers/text-and-data-mining',
        'http://onlinelibrary.wiley.com/termsAndConditions#vor',
        'http://doi.wiley.com/10.1002/tdm_license_1.1',
        'https://www.cambridge.org/core/terms',
        'https://www.acm.org/publications/policies/copyright_policy#Background',
    ] as $url) {
        $r = OaLicenseMapper::parse($url);
        expect($r['license'])->toBe('All-Rights-Reserved', $url);
        expect($r['license_url'])->toBe($url);
    }
    // Elsevier's OPEN-archive user licence is free-to-read publisher terms, not ARR.
    expect(OaLicenseMapper::parse('https://www.elsevier.com/open-access/userlicense/1.0/')['license'])->toBe('Publisher-Open');
    // An unknown publisher URL is not guessed at.
    expect(OaLicenseMapper::parse('https://example-press.org/terms'))->toBeNull();
});

test('the eu-repo open-access statement is read with spaces too', function () use ($code) {
    expect($code('INFO:EU REPO/SEMANTICS/OPENACCESS'))->toBe('Open-Unspecified');
});
