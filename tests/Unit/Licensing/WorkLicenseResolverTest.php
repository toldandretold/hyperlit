<?php

/**
 * WorkLicenseResolver::resolve — the evidence ladder for a work Hyperlit did not author.
 * First RECOGNISED licence wins; an unrecognised string only wins when nothing after it is
 * recognised; nothing at all → decided by OA status.
 */

use App\Services\Licensing\WorkLicenseResolver;

test('the downloaded copy\'s licence outranks the work licence', function () {
    expect(WorkLicenseResolver::resolve(['cc-by-nc', 'cc-by'], 'gold')['license'])->toBe('CC-BY-NC');
});

test('a blank won-copy licence does not mask a known work licence', function () {
    // The old `won_license ?? work_license` let '' through and reported Open-Unspecified.
    expect(WorkLicenseResolver::resolve(['', 'cc-by'], 'gold')['license'])->toBe('CC-BY');
});

test('a copyright notice yields to a real licence later in the ladder', function () {
    expect(WorkLicenseResolver::resolve(['© 2023 The Authors', 'cc-by'], 'gold')['license'])->toBe('CC-BY');
});

test('the journal DOAJ licence is the last evidence before OA status', function () {
    expect(WorkLicenseResolver::resolve([null, null, 'CC BY-NC-ND'], 'diamond')['license'])->toBe('CC-BY-NC-ND');
});

test('a version-less family is completed by a later candidate stating a version of the SAME family', function () {
    // OpenAlex "cc-by" + the old mapper's shouted URL carrying "/4.0/" → CC BY 4.0.
    expect(WorkLicenseResolver::resolve(['cc-by', 'HTTP://CREATIVECOMMONS.ORG/LICENSES/BY/4.0/DEED.NO'], 'gold')['license'])->toBe('CC-BY-4.0');
    // A different family never completes it — the higher-priority evidence stands.
    expect(WorkLicenseResolver::resolve(['cc-by', 'https://creativecommons.org/licenses/by-nc/3.0/'], 'gold')['license'])->toBe('CC-BY');
    // A versioned first hit is final.
    expect(WorkLicenseResolver::resolve(['cc-by-3.0', 'https://creativecommons.org/licenses/by/4.0/'], 'gold')['license'])->toBe('CC-BY-3.0');
});

test('a multi-licence or unrecognised journal statement is not used as article evidence', function () {
    expect(WorkLicenseResolver::usableJournalLicense('CC BY, CC BY-SA'))->toBeNull();
    expect(WorkLicenseResolver::usableJournalLicense('Journal own licence v2'))->toBeNull();
    expect(WorkLicenseResolver::usableJournalLicense('CC BY-NC-ND'))->toBe('CC BY-NC-ND');
});

test('an unrecognised statement is kept honestly when nothing better exists', function () {
    $r = WorkLicenseResolver::resolve(['https://hdl.handle.net/1887/license:3'], 'green');
    expect($r['license'])->toBe('custom');
    expect($r['license_url'])->toBe('https://hdl.handle.net/1887/license:3');
});

test('no evidence: bronze is all rights reserved', function () {
    expect(WorkLicenseResolver::resolve([null, ''], 'bronze')['license'])->toBe('All-Rights-Reserved');
});
