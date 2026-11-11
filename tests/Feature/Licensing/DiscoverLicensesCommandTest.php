<?php

/**
 * library:discover-licenses end to end against faked upstreams: what it asks, what it records,
 * what it writes, and what it must never touch.
 */

use App\Services\Licensing\Sources\PoliteHttp;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    PoliteHttp::$intervalScale = 0;
});

afterEach(function () {
    $db = DB::connection('pgsql_admin');
    $db->table('license_evidence')->where('book', 'like', 'disc_%')->delete();
    $db->table('library')->where('book', 'like', 'disc_%')->delete();
    $db->table('library')->where('book', 'like', 'remapbulk_%')->delete();
    PoliteHttp::$intervalScale = 1.0;
});

function discSeed(string $book, array $attrs = []): void
{
    DB::connection('pgsql_admin')->table('library')->insert(array_merge([
        'book' => $book, 'title' => $book, 'visibility' => 'public', 'creator' => 'canonicalizer_v1',
        'license' => 'Unknown', 'has_nodes' => false, 'timestamp' => 1000,
        'raw_json' => json_encode(['book' => $book]), 'created_at' => now(), 'updated_at' => now(),
    ], $attrs));
}

function discRow(string $book): object
{
    return DB::connection('pgsql_admin')->table('library')->where('book', $book)
        ->first(['license', 'license_url', 'license_source', 'license_checked_at', 'timestamp']);
}

function crossrefLicence(string $url): array
{
    return ['message' => ['license' => [['URL' => $url, 'content-version' => 'vor', 'start' => ['date-parts' => [[2020, 1, 1]]]]]]];
}

test('a dry run records evidence but writes no licence; --apply then reuses it without asking again', function () {
    discSeed('disc_a', ['doi' => '10.1234/disc.a']);
    Http::fake(['api.crossref.org/*' => Http::response(crossrefLicence('https://creativecommons.org/licenses/by-nc/3.0/'))]);

    $this->artisan('library:discover-licenses', ['--book' => ['disc_a'], '--source' => ['crossref']])->assertSuccessful();

    expect(discRow('disc_a')->license)->toBe('Unknown');
    $ev = DB::connection('pgsql_admin')->table('license_evidence')->where('book', 'disc_a')->first();
    expect($ev->source)->toBe('crossref');
    expect($ev->mapped_code)->toBe('CC-BY-NC-3.0');
    Http::assertSentCount(1);

    $this->artisan('library:discover-licenses', ['--book' => ['disc_a'], '--source' => ['crossref'], '--apply' => true])->assertSuccessful();

    Http::assertSentCount(1); // decided from stored evidence
    $row = discRow('disc_a');
    expect($row->license)->toBe('CC-BY-NC-3.0');
    expect($row->license_source)->toBe('crossref');
    expect($row->license_checked_at)->not->toBeNull();
    expect((int) $row->timestamp)->toBeGreaterThan(1000); // open readers refresh
});

test('a row whose sources are silent keeps its licence and its timestamp, but is stamped checked', function () {
    discSeed('disc_silent', ['doi' => '10.1234/disc.silent']);
    Http::fake(['api.crossref.org/*' => Http::response(['message' => ['license' => []]])]);

    $this->artisan('library:discover-licenses', ['--book' => ['disc_silent'], '--source' => ['crossref'], '--apply' => true])->assertSuccessful();

    $row = discRow('disc_silent');
    expect($row->license)->toBe('Unknown');
    expect((int) $row->timestamp)->toBe(1000);
    expect($row->license_checked_at)->not->toBeNull();
    expect(DB::connection('pgsql_admin')->table('license_evidence')->where('book', 'disc_silent')->value('raw'))->toBeNull();
});

test('never touches a licence a person chose, a user\'s own book, or a sub-book', function () {
    discSeed('disc_user_choice', ['doi' => '10.1234/u', 'license_source' => 'user']);
    discSeed('disc_own_book', ['doi' => '10.1234/o', 'creator' => 'somebody']);
    discSeed('disc_parent/Fn1', ['doi' => '10.1234/f']);
    Http::fake(['api.crossref.org/*' => Http::response(crossrefLicence('https://creativecommons.org/licenses/by/4.0/'))]);

    $this->artisan('library:discover-licenses', [
        '--book' => ['disc_user_choice', 'disc_own_book', 'disc_parent/Fn1'], '--source' => ['crossref'], '--apply' => true,
    ])->expectsOutputToContain('0 row(s) in scope')->assertSuccessful();

    Http::assertNothingSent();
    foreach (['disc_user_choice', 'disc_own_book', 'disc_parent/Fn1'] as $b) {
        expect(discRow($b)->license)->toBe('Unknown');
    }
});

test('an AAM/VoR mismatch: Crossref is not asked to speak for a hosted accepted manuscript', function () {
    discSeed('disc_aam', ['doi' => '10.1234/aam', 'has_nodes' => true]);
    $dir = resource_path('markdown/disc_aam');
    @mkdir($dir, 0777, true);
    file_put_contents("{$dir}/fetch_trace.json", json_encode(['won_license' => null, 'won_version' => 'acceptedVersion']));
    Http::fake(['api.crossref.org/*' => Http::response(crossrefLicence('https://www.elsevier.com/tdm/userlicense/1.0/'))]);

    try {
        $this->artisan('library:discover-licenses', ['--book' => ['disc_aam'], '--source' => ['fetch_trace', 'crossref'], '--apply' => true])->assertSuccessful();
    } finally {
        @unlink("{$dir}/fetch_trace.json");
        @rmdir($dir);
    }

    Http::assertNothingSent();
    expect(discRow('disc_aam')->license)->toBe('Unknown');
});

test('a source that keeps failing stops the run (exit 2) before stamping rows it never answered', function () {
    foreach (range(1, 8) as $i) {
        discSeed("disc_down_{$i}", ['doi' => "10.1234/down.{$i}"]);
    }
    Http::fake(['api.crossref.org/*' => Http::response('', 503)]);

    $this->artisan('library:discover-licenses', [
        '--book' => array_map(fn ($i) => "disc_down_{$i}", range(1, 8)), '--source' => ['crossref'], '--apply' => true,
    ])->assertExitCode(2);

    $stamped = DB::connection('pgsql_admin')->table('library')->where('book', 'like', 'disc_down_%')->whereNotNull('license_checked_at')->count();
    expect($stamped)->toBeLessThan(8);
    expect(DB::connection('pgsql_admin')->table('license_evidence')->where('book', 'like', 'disc_down_%')->count())->toBe(0);
});

test('the version-less scope: an OpenAlex family is completed by Crossref\'s stated version', function () {
    discSeed('disc_family', ['doi' => '10.1234/fam', 'license' => 'CC-BY-NC-ND', 'license_source' => 'remap']);
    Http::fake([
        'api.crossref.org/*' => Http::response(crossrefLicence('http://creativecommons.org/licenses/by-nc-nd/3.0/')),
        'api.openalex.org/*' => Http::response(['id' => 'https://openalex.org/W1', 'primary_location' => ['license' => 'cc-by-nc-nd']]),
    ]);

    $this->artisan('library:discover-licenses', ['--book' => ['disc_family'], '--scope' => 'versionless', '--source' => ['crossref', 'openalex'], '--apply' => true])
        ->assertSuccessful();

    expect(discRow('disc_family')->license)->toBe('CC-BY-NC-ND-3.0');
});

test('remap --apply repairs every row in one pass (keyset, not offset, pagination)', function () {
    // lazy() paged by OFFSET while each applied row left the query — a dry run said 5,510 and
    // --apply changed 3,010. 2,100 rows spans three 1,000-row pages.
    $rows = [];
    foreach (range(1, 2100) as $i) {
        $book = sprintf('remapbulk_%05d', $i);
        $rows[] = ['book' => $book, 'title' => $book, 'visibility' => 'public', 'creator' => 'canonicalizer_v1',
            'license' => 'CC-BY-SA-4.0-NO-AI', 'raw_json' => '{}', 'created_at' => now(), 'updated_at' => now()];
    }
    foreach (array_chunk($rows, 500) as $chunk) {
        DB::connection('pgsql_admin')->table('library')->insert($chunk);
    }

    $this->artisan('library:remap-licenses', ['--book' => array_column($rows, 'book'), '--apply' => true])->assertSuccessful();

    expect(DB::connection('pgsql_admin')->table('library')->where('book', 'like', 'remapbulk_%')->where('license', 'CC-BY-SA-4.0-NO-AI')->count())->toBe(0);
});
