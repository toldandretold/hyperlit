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

/**
 * library.url is the citation's outward link. It must be the DOI, not the copy the harvester
 * happened to find: publisher deep links (Bristol's `/downloadpdf/…`) 403 on a click, and left
 * NULL the source container fell through to that dead PDF.
 */
test('mintSystemRow sets url to the DOI resolver, not the harvested PDF', function () {
    $id = canonvSeedCanonical([
        'title'   => 'CanonV Doi Link Work',
        'doi'     => '10.1332/canonv-doi-link',
        'oa_url'  => 'https://publisher.example/downloadpdf/article.pdf',
        'pdf_url' => 'https://publisher.example/downloadpdf/article.pdf',
    ]);

    $book = app(SystemVersionMinter::class)->mintSystemRow(
        CanonicalSource::on('pgsql_admin')->find($id),
        AutoVersionResolver::CONVERSION_METHOD,
        AutoVersionResolver::FOUNDATION_SOURCE,
    );

    $row = canonvDb()->table('library')->where('book', $book)->first(['url', 'doi', 'oa_url']);
    expect($row->url)->toBe('https://doi.org/10.1332/canonv-doi-link');
    // The copy is still recorded — it's the fetch target, just not the citation link.
    expect($row->oa_url)->toBe('https://publisher.example/downloadpdf/article.pdf');
});

test('mintSystemRow falls back to the OA url when the canonical has no DOI', function () {
    $id = canonvSeedCanonical([
        'title'  => 'CanonV No Doi Work',
        'doi'    => null,
        'oa_url' => 'https://repository.example/paper.html',
    ]);

    $book = app(SystemVersionMinter::class)->mintSystemRow(
        CanonicalSource::on('pgsql_admin')->find($id),
        AutoVersionResolver::CONVERSION_METHOD,
        AutoVersionResolver::FOUNDATION_SOURCE,
    );

    expect(canonvDb()->table('library')->where('book', $book)->value('url'))
        ->toBe('https://repository.example/paper.html');
});
