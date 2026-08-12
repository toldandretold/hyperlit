<?php

/**
 * SystemVersionMinter carries the canonical's biblio identity (volume/issue)
 * onto the minted library row — journal pages sort feeds by publication order
 * (year → volume → issue), so a version book without them sinks wrongly.
 */

use App\Models\CanonicalSource;
use App\Services\CanonicalVersions\AutoVersionResolver;
use App\Services\CanonicalVersions\SystemVersionMinter;

require_once __DIR__ . '/CanonicalSeedHelpers.php';

beforeEach(function () {
    canonvCleanup();
});

test('mintSystemRow copies volume and issue from the canonical', function () {
    $id = canonvSeedCanonical([
        'title'  => 'CanonV Biblio Work',
        'year'   => 2024,
        'volume' => '12',
        'issue'  => 'S1',
    ]);

    $book = app(SystemVersionMinter::class)->mintSystemRow(
        CanonicalSource::on('pgsql_admin')->find($id),
        AutoVersionResolver::CONVERSION_METHOD,
        AutoVersionResolver::FOUNDATION_SOURCE,
    );

    $row = canonvDb()->table('library')->where('book', $book)->first(['year', 'volume', 'issue', 'title']);
    expect($row->year)->toBe('2024'); // library.year is a TEXT display column
    expect($row->volume)->toBe('12');
    expect($row->issue)->toBe('S1');

    // Cleanup guard: the minted row carries the CanonV title prefix.
    expect($row->title)->toBe('CanonV Biblio Work');
});
