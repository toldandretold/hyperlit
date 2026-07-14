<?php

/**
 * YieldReportBook — the readable "Source Yield Report" the harvest writes onto
 * the shelf. Its "Harvested" section now reflects DURABLE state (the 5th arg,
 * HarvestEligibility::harvestedNetworkFor), so the report shows what HAS been
 * harvested regardless of which run pulled it or whether a run crashed. The
 * "Failed to Harvest" section still comes from the accumulated results union
 * (a failed fetch leaves no durable trace). No-network: called directly against
 * admin-seeded rows. Admin writes commit, so everything is cleaned in afterEach.
 */

use App\Services\SourceHarvest\YieldReportBook;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function yrDb()
{
    return DB::connection('pgsql_admin');
}

function yrSeedBook(array $opts = []): string
{
    $book = $opts['book'] ?? ('yrtest_' . Str::random(10));
    yrDb()->table('library')->insert(array_merge([
        'book'       => $book,
        'title'      => 'YRTest Root',
        'visibility' => 'private',
        'raw_json'   => json_encode(['book' => $book]),
        'created_at' => now(),
        'updated_at' => now(),
    ], $opts));
    return $book;
}

/**
 * Canned FAILURE outcomes (the `results` / union input): a Cloudflare block +
 * an unverifiable deferred. With $parent set they carry lineage fields.
 */
function yrFailures(?string $parent = null): array
{
    $lineage = $parent ? ['depth' => 1, 'parent_book' => $parent, 'cited_by_count' => 42] : [];
    return [
        ['canonical_source_id' => (string) Str::uuid(), 'title' => 'The Rational Kernel', 'author' => 'Amin, Samir', 'year' => 1985, 'journal' => 'Review', 'type' => 'journal-article', 'doi' => '10.1111/rational', 'oa_url' => null, 'pdf_url' => null, 'status' => 'fetch_failed', 'reason' => 'Browser fetch failed: cloudflare_block', 'via' => null, 'book' => null] + $lineage,
        ['canonical_source_id' => (string) Str::uuid(), 'title' => 'A Moment of Possibility', 'author' => 'Doe, Jane', 'year' => 2020, 'type' => 'book', 'doi' => null, 'oa_url' => 'https://hdl.handle.net/2440/123', 'pdf_url' => null, 'status' => 'deferred', 'reason' => 'stub has no converted content yet', 'via' => null, 'book' => null] + $lineage,
    ];
}

/**
 * A DURABLE harvested entry (as HarvestEligibility::harvestedNetworkFor would
 * return it): a canonical with an auto_version_book, shaped for the report.
 */
function yrHarvested(string $book = 'yrtest_held_book', array $opts = []): array
{
    return array_merge([
        'canonical_source_id' => (string) Str::uuid(),
        'title'          => 'Accumulation on a World Scale',
        'author'         => 'Amin, Samir',
        'year'           => 1974,
        'journal'        => null,
        'publisher'      => null,
        'type'           => 'book',
        'doi'            => '10.2307/accum',
        'openalex_id'    => null,
        'oa_url'         => null,
        'pdf_url'        => null,
        'cited_by_count' => 42,
        'status'         => 'assigned',
        'reason'         => null,
        'via'            => 'from europepmc.org',
        'book'           => $book,
        'parent_book'    => null,
        'depth'          => 1,
    ], $opts);
}

/** Failures + a durable success, for tests that don't care about the split. */
function yrResults(?string $parent = null): array
{
    return array_merge(yrFailures($parent), [yrHarvested()]);
}

afterEach(function () {
    $reportIds = yrDb()->table('library')->where('type', 'report')->whereRaw("raw_json->>'report_of' like 'yrtest\\_%'")->pluck('book');
    if ($reportIds->isNotEmpty()) {
        yrDb()->table('nodes')->whereIn('book', $reportIds)->delete();
        yrDb()->table('library')->whereIn('book', $reportIds)->delete();
    }
    yrDb()->table('library')->where('book', 'like', 'yrtest\_%')->delete();
    $shelfIds = yrDb()->table('shelves')->where('creator', 'yrtest_user')->pluck('id');
    if ($shelfIds->isNotEmpty()) {
        yrDb()->table('shelf_items')->whereIn('shelf_id', $shelfIds)->delete();
        yrDb()->table('shelves')->whereIn('id', $shelfIds)->delete();
    }
});

test('generates a readable report book owned by the root creator', function () {
    $root = yrSeedBook(['title' => 'YRTest Neoliberalism', 'creator' => 'yrtest_user']);

    $bookId = app(YieldReportBook::class)->generate($root, 'YRTest Neoliberalism', yrFailures(), null, [yrHarvested()]);

    expect($bookId)->not->toBeNull();
    // Deterministic, readable id tied to the harvested book.
    expect($bookId)->toBe('source-yield-report-' . $root);
    $row = yrDb()->table('library')->where('book', $bookId)->first();
    expect($row->creator)->toBe('yrtest_user');
    expect($row->visibility)->toBe('private');
    expect((bool) $row->has_nodes)->toBeTrue();
    expect($row->type)->toBe('report');
    expect(json_decode($row->raw_json, true)['report_of'])->toBe($root);
    expect($row->title)->toStartWith('Source Yield Report');
});

test('lists failures as formatted citations + links above the harvested section', function () {
    $root = yrSeedBook(['title' => 'YRTest Yield', 'creator' => 'yrtest_user']);
    // Failures via the results union; the success via the DURABLE harvested set.
    $bookId = app(YieldReportBook::class)->generate($root, 'YRTest Yield', yrFailures(), null, [yrHarvested()]);

    $nodes = yrDb()->table('nodes')->where('book', $bookId)->orderBy('startLine')->get();
    $html = $nodes->pluck('content')->implode("\n");
    $plain = $nodes->pluck('plainText')->implode("\n");

    expect($plain)->toContain('Source Yield Report');
    // The intro links back to the source book with an arrow.
    expect($html)->toContain('href="/' . $root . '"');
    expect($html)->toContain('→');
    expect($plain)->toContain('Failed to Harvest');
    expect($plain)->toContain('Harvested');
    expect($plain)->toContain('a human is often needed, comrades');

    // A failure renders as a formatted citation (NOT a raw bibtex block): the
    // article title is quoted and linked to the best source.
    expect($html)->not->toContain('@article{');
    expect($html)->toContain('"The Rational Kernel"');
    expect($html)->toContain('href="https://doi.org/10.1111/rational"');
    expect($html)->toContain('Amin, Samir'); // author leads the citation
    // The Cloudflare reason is humanised.
    expect($html)->toContain('Cloudflare');
    // The deferred one is explained honestly.
    expect($html)->toContain("couldn't verify");

    // The success (durable) is a citation whose title links to the held book.
    expect($html)->toContain('href="/yrtest_held_book"');

    // Failures come before the harvested section.
    $failPos = strpos($plain, 'Failed to Harvest');
    $gotPos = strpos($plain, "\nHarvested");
    expect($failPos)->toBeLessThan($gotPos);

    // Headings must carry a literal id="<startLine>" in their STORED content —
    // the TOC scanner (tocContainer) and /headings endpoint both require it to
    // recognise a heading, else the report's sections never reach the table of
    // contents. The h2s below the intro must each match the heading regex.
    $headingRows = $nodes->filter(fn ($n) => in_array($n->type, ['h1', 'h2'], true));
    expect($headingRows)->not->toBeEmpty();
    foreach ($headingRows as $h) {
        expect($h->content)->toMatch('/^<h[1-6][^>]*\sid="' . $h->startLine . '"/');
    }
});

test('the Harvested section reflects DURABLE state even when the run results are empty', function () {
    // The user's exact scenario: a prior run imported works then crashed before
    // finalizing, so nothing is in the union. A later report with an EMPTY
    // results array still lists everything durably harvested — the report asks
    // the database what exists, not what a run recorded.
    $root = yrSeedBook(['title' => 'YRTest Durable', 'creator' => 'yrtest_user']);

    $durable = [
        yrHarvested('yrtest_book_a', ['canonical_source_id' => (string) Str::uuid(), 'title' => 'Durable Work A']),
        yrHarvested('yrtest_book_b', ['canonical_source_id' => (string) Str::uuid(), 'title' => 'Durable Work B']),
    ];

    $bookId = app(YieldReportBook::class)->generate($root, 'YRTest Durable', [], null, $durable);

    $nodes = yrDb()->table('nodes')->where('book', $bookId)->orderBy('startLine')->get();
    $plain = $nodes->pluck('plainText')->implode("\n");
    $html = $nodes->pluck('content')->implode("\n");

    expect($plain)->toContain('Harvested');
    expect($html)->toContain('Durable Work A');
    expect($html)->toContain('Durable Work B');
    expect($html)->toContain('href="/yrtest_book_a"');
    expect($html)->toContain('href="/yrtest_book_b"');
    // No failures at all (empty union) — no "Failed to Harvest" section.
    expect($plain)->not->toContain('Failed to Harvest');
});

test('failures accumulate in the union across runs while successes come from durable state', function () {
    $root = yrSeedBook(['title' => 'YRTest Rerun', 'creator' => 'yrtest_user']);
    $svc = app(YieldReportBook::class);

    $success1 = yrHarvested('yrtest_held_book', ['title' => 'Accumulation on a World Scale']);

    // First run: 2 failures (union) + 1 durable success.
    $first = $svc->generate($root, 'YRTest Rerun', yrFailures(), null, [$success1]);

    // Second run brings home ONE more work; the durable set now holds BOTH.
    // Its own results are empty (no NEW failures this run).
    $success2 = yrHarvested('yrtest_new_book', ['title' => 'A Newly Harvested Work', 'author' => 'New, Author']);
    $second = $svc->generate($root, 'YRTest Rerun', [], null, [$success1, $success2]);
    expect($second)->toBe($first); // same living report book

    // Exactly one report row for this root.
    expect(yrDb()->table('library')->where('creator', 'yrtest_user')->whereRaw("raw_json->>'report_of' = ?", [$root])->count())->toBe(1);

    $plain = yrDb()->table('nodes')->where('book', $first)->orderBy('startLine')->pluck('plainText')->implode("\n");
    expect($plain)->toContain('Failed to Harvest');            // run 1's failures preserved in the union
    expect($plain)->toContain('Harvested');
    expect($plain)->toContain('A Newly Harvested Work');        // second durable success
    expect($plain)->toContain('Accumulation on a World Scale'); // first durable success still shown
    expect($plain)->toContain('The Rational Kernel');           // run 1's failure still listed
});

test('a durably-harvested work overrides a stale union failure (Failed → Harvested)', function () {
    $root = yrSeedBook(['title' => 'YRTest Upgrade', 'creator' => 'yrtest_user']);
    $svc = app(YieldReportBook::class);

    $cid = (string) Str::uuid();
    // First run: this canonical FAILED (cloudflare) — recorded in the union.
    $svc->generate($root, 'YRTest Upgrade', [
        ['canonical_source_id' => $cid, 'title' => 'The Upgraded Text', 'author' => 'X', 'year' => 2019, 'type' => 'journal-article', 'status' => 'fetch_failed', 'reason' => 'cloudflare_block', 'via' => null, 'book' => null],
    ], null, []);

    // Later: it's now durably harvested. Even though the union still records the
    // failure and this call's results are empty, the report lists it as Harvested
    // and drops it from Failed — durable truth wins.
    $book = $svc->generate($root, 'YRTest Upgrade', [], null, [
        yrHarvested('yrtest_upgraded', ['canonical_source_id' => $cid, 'title' => 'The Upgraded Text', 'author' => 'X', 'year' => 2019, 'type' => 'journal-article']),
    ]);

    $nodes = yrDb()->table('nodes')->where('book', $book)->orderBy('startLine')->get();
    $html = $nodes->pluck('content')->implode("\n");
    $plain = $nodes->pluck('plainText')->implode("\n");

    // Now a harvested citation linking to the held version.
    expect($html)->toContain('href="/yrtest_upgraded"');
    // And it is NOT in a Failed section (the stale union failure is suppressed).
    expect($plain)->not->toContain('Failed to Harvest');
    // The union still physically carries the failure entry (durable state is the
    // display authority, not a rewrite of history).
    $union = json_decode(yrDb()->table('library')->where('book', $book)->value('raw_json'), true)['cumulative_results'];
    expect(collect($union)->firstWhere('canonical_source_id', $cid)['status'])->toBe('fetch_failed');
});

test('a second failure REFRESHES the reason (latest attempt wins on equal rank)', function () {
    $root = yrSeedBook(['title' => 'YRTest Refresh', 'creator' => 'yrtest_user']);
    $svc = app(YieldReportBook::class);

    $cid = (string) Str::uuid();
    // First run: this canonical fails with reason X (a cloudflare wall), DOI-only.
    $svc->generate($root, 'YRTest Refresh', [
        ['canonical_source_id' => $cid, 'title' => 'The Stubborn Text', 'author' => 'X', 'year' => 2019, 'type' => 'journal-article', 'status' => 'fetch_failed', 'reason' => 'cloudflare_block', 'doi' => '10.1111/stubborn', 'oa_url' => null, 'pdf_url' => null, 'via' => null, 'book' => null],
    ]);
    // Second run: SAME canonical fails AGAIN, different reason + a fresh OA link.
    $book = $svc->generate($root, 'YRTest Refresh', [
        ['canonical_source_id' => $cid, 'title' => 'The Stubborn Text', 'author' => 'X', 'year' => 2019, 'type' => 'journal-article', 'status' => 'deferred', 'reason' => 'found a copy but the file was corrupt', 'doi' => '10.1111/stubborn', 'oa_url' => 'https://repo.example/stubborn', 'pdf_url' => null, 'via' => null, 'book' => null],
    ]);

    // The union carries exactly one entry for that canonical, reflecting the
    // SECOND attempt — status, reason and links all refreshed to the latest run.
    $union = json_decode(yrDb()->table('library')->where('book', $book)->value('raw_json'), true)['cumulative_results'];
    expect(collect($union)->where('canonical_source_id', $cid)->count())->toBe(1);
    $entry = collect($union)->firstWhere('canonical_source_id', $cid);
    expect($entry['status'])->toBe('deferred');
    expect($entry['reason'])->toBe('found a copy but the file was corrupt');
    expect($entry['oa_url'])->toBe('https://repo.example/stubborn'); // fresh link from run 2

    // And the rendered report shows the latest reason, not the stale one.
    $html = yrDb()->table('nodes')->where('book', $book)->orderBy('startLine')->pluck('content')->implode("\n");
    expect($html)->toContain("couldn't verify"); // 'deferred' is humanised to this
    expect($html)->not->toContain('blocked by the publisher'); // run 1's humanised reason is gone
    expect($html)->toContain('href="https://repo.example/stubborn"'); // fresh link surfaced
});

test('embeds the knowledge-network data table + 3D expand link', function () {
    $root = yrSeedBook(['title' => 'YRTest Network', 'creator' => 'yrtest_user']);
    $failures = yrFailures($root);                                   // union failures, with lineage
    $success = yrHarvested('yrtest_held_book', ['parent_book' => $root, 'depth' => 1]); // durable success

    $book = app(YieldReportBook::class)->generate($root, 'YRTest Network', $failures, null, [$success]);
    $nodes = yrDb()->table('nodes')->where('book', $book)->orderBy('startLine')->get();

    // The network node: a table carrying the data-chart marker the client
    // graph renderer looks for, under a "Knowledge Network" heading.
    $tableNode = $nodes->firstWhere('type', 'table');
    expect($tableNode)->not->toBeNull();
    expect($tableNode->content)->toContain('data-chart="harvest-network"');
    expect($nodes->pluck('plainText')->implode("\n"))->toContain('Knowledge Network');
    // plainText override: the table's plainText is NOT the smashed cell values.
    expect($tableNode->plainText)->toBe('Harvest knowledge network');

    // First body row is the ROOT (depth 0, status root, root title).
    expect($tableNode->content)->toMatch('/<tbody><tr><td>' . preg_quote($root, '/') . '<\/td><td><\/td><td>0<\/td><td>root<\/td><td>YRTest Network<\/td>/');
    // One row per node (durable success + union failures), lineage + status.
    foreach (array_merge([$success], $failures) as $r) {
        expect($tableNode->content)->toContain('<td>' . $r['canonical_source_id'] . '</td>'
            . '<td>' . $root . '</td><td>1</td><td>' . $r['status'] . '</td>');
    }
    expect($tableNode->content)->toContain('<td>42</td>'); // cited_by_count survives
    // Citation details for the hover card ride along (author / journal / reason).
    expect($tableNode->content)->toContain('<td>Amin, Samir</td>');
    expect($tableNode->content)->toContain('<td>Review</td>');
    expect($tableNode->content)->toContain('<td>Browser fetch failed: cloudflare_block</td>');

    // The expand link to the standalone 3D page.
    $html = $nodes->pluck('content')->implode("\n");
    expect($html)->toContain('href="/3d/' . $root . '?layers=hypercite,citation_verified,citation_auto"');
});

test('legacy union failures without lineage still land in the network table (defaults)', function () {
    $root = yrSeedBook(['title' => 'YRTest Legacy', 'creator' => 'yrtest_user']);
    // Legacy shape: no depth / parent_book (pre-lineage harvests) on the failures.
    $failures = yrFailures();

    $book = app(YieldReportBook::class)->generate($root, 'YRTest Legacy', $failures, null, [yrHarvested()]);
    $tableNode = yrDb()->table('nodes')->where('book', $book)->where('type', 'table')->first();

    expect($tableNode)->not->toBeNull();
    // Every failure defaults to depth 1, parented to the root — a 1-level fan.
    foreach ($failures as $r) {
        expect($tableNode->content)->toContain('<td>' . $r['canonical_source_id'] . '</td>'
            . '<td>' . $root . '</td><td>1</td>');
    }
});

test('purges a stale old-convention report for the same root', function () {
    $root = yrSeedBook(['title' => 'YRTest Purge', 'creator' => 'yrtest_user']);

    // An old random-UUID report from before the deterministic-id change,
    // still on a shelf.
    $oldId = (string) Str::uuid();
    yrDb()->table('library')->insert([
        'book' => $oldId, 'title' => 'Source Yield Report — old', 'creator' => 'yrtest_user',
        'visibility' => 'private', 'listed' => false, 'has_nodes' => true, 'type' => 'report',
        'raw_json' => json_encode(['type' => 'report', 'report_of' => $root]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    yrDb()->table('nodes')->insert(['book' => $oldId, 'startLine' => 1, 'chunk_id' => 0, 'node_id' => $oldId . '_r1', 'content' => '<p>old</p>', 'plainText' => 'old', 'type' => 'p', 'created_at' => now(), 'updated_at' => now()]);
    $shelfId = (string) Str::uuid();
    yrDb()->table('shelves')->insert(['id' => $shelfId, 'creator' => 'yrtest_user', 'name' => 'YRTest Shelf', 'slug' => 'yrtest-shelf-' . Str::random(6), 'visibility' => 'private', 'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now()]);
    yrDb()->table('shelf_items')->insert(['shelf_id' => $shelfId, 'book' => $oldId, 'added_at' => now()]);

    $newId = app(YieldReportBook::class)->generate($root, 'YRTest Purge', yrFailures(), null, [yrHarvested()]);

    expect($newId)->toBe('source-yield-report-' . $root);
    // The old report — row, nodes, and shelf item — is gone.
    expect(yrDb()->table('library')->where('book', $oldId)->exists())->toBeFalse();
    expect(yrDb()->table('nodes')->where('book', $oldId)->exists())->toBeFalse();
    expect(yrDb()->table('shelf_items')->where('book', $oldId)->exists())->toBeFalse();
    // Exactly one report remains for this root.
    expect(yrDb()->table('library')->whereRaw("raw_json->>'report_of' = ?", [$root])->count())->toBe(1);
});

test('returns null when the root book has no named creator', function () {
    $anon = yrSeedBook(['title' => 'YRTest Anon', 'creator' => null, 'creator_token' => (string) Str::uuid()]);
    expect(app(YieldReportBook::class)->generate($anon, 'YRTest Anon', yrResults()))->toBeNull();
});
