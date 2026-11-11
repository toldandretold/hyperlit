<?php

/**
 * A minted system version carries the WORK's licence, not the column default.
 *
 * Before WorkLicenseResolver, SystemVersionMinter copied only `work_license` and left
 * `license` at CC-BY-SA-4.0-NO-AI — Hyperlit's licence for a user's own writing — and the
 * journal HTML lane and ar5iv never pass through AutoVersionCreator to fix it. So a CC BY-NC-ND
 * journal article was shown to readers as copyleft-No-AI.
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\SystemVersionMinter;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

function canonvMintLicense(array $canonical): object
{
    $id = canonvSeedCanonical(array_merge(['title' => 'CanonV Licence Work', 'year' => 2024], $canonical));
    $book = app(SystemVersionMinter::class)->mintSystemRow(
        CanonicalSource::on('pgsql_admin')->find($id),
        AutoVersionResolver::CONVERSION_METHOD,
        AutoVersionResolver::FOUNDATION_SOURCE,
    );

    return canonvDb()->table('library')->where('book', $book)->first(['license', 'custom_license_text', 'license_url', 'work_license']);
}

test('a CC slug becomes its version-less CC family code', function () {
    $row = canonvMintLicense(['work_license' => 'cc-by-nc-nd', 'oa_status' => 'gold']);
    expect($row->license)->toBe('CC-BY-NC-ND');
    expect($row->work_license)->toBe('cc-by-nc-nd');
});

test('a CC URL is read, not filed as shouted custom text', function () {
    $row = canonvMintLicense(['work_license' => 'https://creativecommons.org/licenses/by/3.0/', 'oa_status' => 'gold']);
    expect($row->license)->toBe('CC-BY-3.0');
    expect($row->custom_license_text)->toBeNull();
});

test('no licence on an open work is open-unspecified, never the site default', function () {
    $row = canonvMintLicense(['work_license' => null, 'oa_status' => 'diamond']);
    expect($row->license)->toBe('Open-Unspecified');
});
