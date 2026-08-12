<?php

/**
 * journal:sync-registry — the diamond-journal registry sync. Locks the diamond
 * rule (DOAJ's explicit no-APC flag is the authority; OpenAlex apc_usd null
 * means UNKNOWN, not free), provenance labels, slug stability across re-syncs,
 * the DOAJ-publisher backfill, --limit / --dry-run, and the CSV parser's
 * header-name (not positional) contract.
 *
 * OpenAlex HTTP is Http::fake'd; the DOAJ CSV download is partial-mocked
 * (loadCsvIndex sinks to disk — the parser itself is tested against a fixture
 * file). Registry writes go through Eloquent (default connection), so
 * RefreshDatabase rolls them back — assertions read the default connection.
 */

use App\Models\JournalSource;
use App\Services\JournalHarvest\DoajJournalDirectory;
use Illuminate\Support\Facades\Http;

function jsyncRawSource(array $overrides = []): array
{
    return array_merge([
        'id'                     => 'https://openalex.org/SJSYNC1',
        'display_name'           => 'JSync Journal One',
        'issn_l'                 => '1111-1111',
        'issn'                   => ['1111-1111'],
        'is_oa'                  => true,
        'is_in_doaj'             => true,
        'apc_usd'                => null,
        'works_count'            => 100,
        'cited_by_count'         => 5000,
        'summary_stats'          => ['2yr_mean_citedness' => 1.5],
        'country_code'           => 'GB',
        'homepage_url'           => 'https://example.org/jsync',
        'host_organization_name' => 'JSync Press',
        'topics'                 => [],
    ], $overrides);
}

function fakeSourcesPage(array $sources): void
{
    Http::fake([
        'api.openalex.org/sources*' => Http::response([
            'results' => $sources,
            'meta'    => ['count' => count($sources), 'next_cursor' => null],
        ]),
    ]);
}

function fakeDoajIndex(array $index): void
{
    test()->partialMock(DoajJournalDirectory::class, function ($mock) use ($index) {
        $mock->shouldReceive('loadCsvIndex')->andReturn($index);
    });
}

// ── The diamond rule itself (pure) ──

test('diamond rule: apc_usd 0 is diamond regardless of DOAJ', function () {
    [$isDiamond, $prov] = (new DoajJournalDirectory())->isDiamond(['apc_usd' => 0], null);
    expect($isDiamond)->toBeTrue();
    expect($prov)->toBe(DoajJournalDirectory::PROVENANCE_OPENALEX_APC_0);
});

test('diamond rule: apc_usd null + DOAJ no-APC is diamond via doaj_no_apc', function () {
    [$isDiamond, $prov] = (new DoajJournalDirectory())->isDiamond(['apc_usd' => null], ['has_apc' => false]);
    expect($isDiamond)->toBeTrue();
    expect($prov)->toBe(DoajJournalDirectory::PROVENANCE_DOAJ_NO_APC);
});

test('diamond rule: DOAJ has-APC is NOT diamond even with null apc_usd', function () {
    [$isDiamond, $prov] = (new DoajJournalDirectory())->isDiamond(['apc_usd' => null], ['has_apc' => true]);
    expect($isDiamond)->toBeFalse();
    expect($prov)->toBeNull();
});

test('diamond rule: no DOAJ record is UNKNOWN (null), never asserted diamond', function () {
    [$isDiamond, $prov] = (new DoajJournalDirectory())->isDiamond(['apc_usd' => null], null);
    expect($isDiamond)->toBeNull();
    expect($prov)->toBeNull();
});

// ── CSV parser contract ──

test('parseCsvIndex keys by both ISSNs, reads APC by header name, fails loudly on drift', function () {
    $dir = sys_get_temp_dir();

    $good = $dir . '/jsync_doaj_good.csv';
    file_put_contents($good,
        "Journal title,APC,Journal ISSN (print version),Journal EISSN (online version),Publisher,Languages in which the journal accepts manuscripts\n"
        . "Free Journal,No,1234-5678,8765-4321,Small Press,\"English, French\"\n"
        . "Paid Journal,Yes,,2222-3333,Big Press,English\n"
    );

    $index = (new DoajJournalDirectory())->parseCsvIndex($good);

    expect($index['1234-5678']['has_apc'])->toBeFalse();
    expect($index['8765-4321']['has_apc'])->toBeFalse();     // same row, either ISSN
    expect($index['1234-5678']['publisher'])->toBe('Small Press');
    expect($index['1234-5678']['languages'])->toBe(['English', 'French']);
    expect($index['2222-3333']['has_apc'])->toBeTrue();
    expect($index)->not->toHaveKey('');                       // blank print ISSN not indexed

    $drifted = $dir . '/jsync_doaj_drifted.csv';
    file_put_contents($drifted, "Journal title,Article processing charge\nX,No\n");
    expect(fn() => (new DoajJournalDirectory())->parseCsvIndex($drifted))
        ->toThrow(RuntimeException::class, 'drifted');
});

// ── Full sync ──

test('full sync stores diamonds with provenance, skips non-diamond and unknown', function () {
    fakeSourcesPage([
        jsyncRawSource(['id' => 'https://openalex.org/SJSYNC1', 'display_name' => 'JSync Apc Zero', 'apc_usd' => 0, 'issn_l' => '1111-1111', 'issn' => ['1111-1111']]),
        jsyncRawSource(['id' => 'https://openalex.org/SJSYNC2', 'display_name' => 'JSync Doaj Free', 'issn_l' => '2222-2222', 'issn' => ['2222-2222'], 'host_organization_name' => null, 'cited_by_count' => 900]),
        jsyncRawSource(['id' => 'https://openalex.org/SJSYNC3', 'display_name' => 'JSync Doaj Paid', 'issn_l' => '3333-3333', 'issn' => ['3333-3333']]),
        jsyncRawSource(['id' => 'https://openalex.org/SJSYNC4', 'display_name' => 'JSync Unknown', 'issn_l' => '4444-4444', 'issn' => ['4444-4444']]),
    ]);
    fakeDoajIndex([
        '2222-2222' => ['has_apc' => false, 'publisher' => 'Doaj Society Press', 'languages' => ['English']],
        '3333-3333' => ['has_apc' => true, 'publisher' => 'Paid Press', 'languages' => []],
    ]);

    $this->artisan('journal:sync-registry')->assertExitCode(0);

    expect(JournalSource::where('openalex_source_id', 'LIKE', 'SJSYNC%')->count())->toBe(2);

    $apcZero = JournalSource::where('openalex_source_id', 'SJSYNC1')->first();
    expect($apcZero->is_diamond)->toBeTrue();
    expect($apcZero->diamond_provenance)->toBe('openalex_apc_0');
    expect($apcZero->cited_by_count)->toBe(5000);
    expect($apcZero->two_year_mean_citedness)->toBe(1.5);
    expect($apcZero->slug)->toBe('jsync-apc-zero');

    $doajFree = JournalSource::where('openalex_source_id', 'SJSYNC2')->first();
    expect($doajFree->is_diamond)->toBeTrue();
    expect($doajFree->diamond_provenance)->toBe('doaj_no_apc');
    // OpenAlex had no publisher — DOAJ backfills it.
    expect($doajFree->publisher)->toBe('Doaj Society Press');
    expect($doajFree->languages)->toBe(['English']);

    expect(JournalSource::where('openalex_source_id', 'SJSYNC3')->exists())->toBeFalse();
    expect(JournalSource::where('openalex_source_id', 'SJSYNC4')->exists())->toBeFalse();
});

test('--include-non-diamond stores them with is_diamond false', function () {
    fakeSourcesPage([
        jsyncRawSource(['id' => 'https://openalex.org/SJSYNC3', 'display_name' => 'JSync Doaj Paid', 'issn_l' => '3333-3333', 'issn' => ['3333-3333']]),
    ]);
    fakeDoajIndex(['3333-3333' => ['has_apc' => true, 'publisher' => 'Paid Press', 'languages' => []]]);

    $this->artisan('journal:sync-registry', ['--include-non-diamond' => true])->assertExitCode(0);

    $row = JournalSource::where('openalex_source_id', 'SJSYNC3')->first();
    expect($row)->not->toBeNull();
    expect($row->is_diamond)->toBeFalse();
    expect($row->diamond_provenance)->toBeNull();
});

test('re-sync refreshes stats but NEVER rewrites the slug', function () {
    fakeDoajIndex(['1111-1111' => ['has_apc' => false, 'publisher' => 'P', 'languages' => []]]);

    // One stateful stub for both runs — a second Http::fake would NOT
    // replace the first matching stub.
    $call = 0;
    Http::fake([
        'api.openalex.org/sources*' => function () use (&$call) {
            $call++;
            $source = $call === 1
                ? jsyncRawSource(['display_name' => 'JSync Original Name', 'cited_by_count' => 10])
                : jsyncRawSource(['display_name' => 'JSync Renamed', 'cited_by_count' => 99]);
            return Http::response(['results' => [$source], 'meta' => ['count' => 1, 'next_cursor' => null]]);
        },
    ]);

    $this->artisan('journal:sync-registry')->assertExitCode(0);
    $row = JournalSource::where('openalex_source_id', 'SJSYNC1')->first();
    expect($row->slug)->toBe('jsync-original-name');

    // The journal renames itself upstream; our slug is (going to be) a URL.
    $this->artisan('journal:sync-registry')->assertExitCode(0);

    $row->refresh();
    expect(JournalSource::where('openalex_source_id', 'SJSYNC1')->count())->toBe(1);
    expect($row->display_name)->toBe('JSync Renamed');
    expect($row->cited_by_count)->toBe(99);
    expect($row->slug)->toBe('jsync-original-name');
});

test('--limit stops after N stored, --dry-run writes nothing', function () {
    $sources = [];
    foreach ([1, 2, 3] as $i) {
        $sources[] = jsyncRawSource([
            'id'           => "https://openalex.org/SJSYNCL{$i}",
            'display_name' => "JSync Limited {$i}",
            'issn_l'       => "555{$i}-555{$i}",
            'issn'         => ["555{$i}-555{$i}"],
            'apc_usd'      => 0,
        ]);
    }
    fakeSourcesPage($sources);
    fakeDoajIndex([]);

    $this->artisan('journal:sync-registry', ['--limit' => 2])->assertExitCode(0);
    expect(JournalSource::where('openalex_source_id', 'LIKE', 'SJSYNCL%')->count())->toBe(2);

    JournalSource::where('openalex_source_id', 'LIKE', 'SJSYNCL%')->delete();
    fakeSourcesPage($sources);
    fakeDoajIndex([]);
    $this->artisan('journal:sync-registry', ['--dry-run' => true])->assertExitCode(0);
    expect(JournalSource::where('openalex_source_id', 'LIKE', 'SJSYNCL%')->count())->toBe(0);
});

// ── Single-ISSN pilot path ──

test('--issn syncs one journal via the DOAJ API', function () {
    Http::fake([
        'api.openalex.org/sources*' => Http::response([
            'results' => [jsyncRawSource(['host_organization_name' => null])],
            'meta'    => ['count' => 1, 'next_cursor' => null],
        ]),
        'doaj.org/api/search/journals/*' => Http::response([
            'results' => [[
                'bibjson' => [
                    'apc'           => ['has_apc' => false],
                    'other_charges' => ['has_other_charges' => false],
                    'publisher'     => ['name' => 'Bristol University Press', 'country' => 'GB'],
                    'language'      => ['EN'],
                ],
            ]],
        ]),
    ]);

    $this->artisan('journal:sync-registry', ['--issn' => '1111-1111'])->assertExitCode(0);

    $row = JournalSource::where('openalex_source_id', 'SJSYNC1')->first();
    expect($row)->not->toBeNull();
    expect($row->is_diamond)->toBeTrue();
    expect($row->diamond_provenance)->toBe('doaj_no_apc');
    expect($row->publisher)->toBe('Bristol University Press');
});

test('--issn refuses to store a journal DOAJ says charges an APC', function () {
    Http::fake([
        'api.openalex.org/sources*' => Http::response([
            'results' => [jsyncRawSource()],
            'meta'    => ['count' => 1, 'next_cursor' => null],
        ]),
        'doaj.org/api/search/journals/*' => Http::response([
            'results' => [['bibjson' => ['apc' => ['has_apc' => true], 'publisher' => ['name' => 'X']]]],
        ]),
    ]);

    $this->artisan('journal:sync-registry', ['--issn' => '1111-1111'])->assertExitCode(1);
    expect(JournalSource::where('openalex_source_id', 'LIKE', 'SJSYNC%')->count())->toBe(0);
});
