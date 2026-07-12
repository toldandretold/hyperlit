<?php

/**
 * YieldReportBook — the readable "Source Yield Report" the harvest writes onto
 * the shelf, listing what it couldn't pull (BibTeX + links) above what it did.
 * No-network: called directly against admin-seeded rows + a canned results
 * array. Admin writes commit, so everything is cleaned in afterEach.
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

function yrResults(): array
{
    return [
        // A Cloudflare failure with a DOI.
        ['canonical_source_id' => (string) Str::uuid(), 'title' => 'The Rational Kernel', 'author' => 'Amin, Samir', 'year' => 1985, 'journal' => 'Review', 'type' => 'journal-article', 'doi' => '10.1111/rational', 'oa_url' => null, 'pdf_url' => null, 'status' => 'fetch_failed', 'reason' => 'Browser fetch failed: cloudflare_block', 'via' => null, 'book' => null],
        // A deferred (unverifiable) failure with an oa_url.
        ['canonical_source_id' => (string) Str::uuid(), 'title' => 'A Moment of Possibility', 'author' => 'Doe, Jane', 'year' => 2020, 'type' => 'book', 'doi' => null, 'oa_url' => 'https://hdl.handle.net/2440/123', 'pdf_url' => null, 'status' => 'deferred', 'reason' => 'stub has no converted content yet', 'via' => null, 'book' => null],
        // A success with a held book.
        ['canonical_source_id' => (string) Str::uuid(), 'title' => 'Accumulation on a World Scale', 'author' => 'Amin, Samir', 'year' => 1974, 'type' => 'book', 'doi' => '10.2307/accum', 'status' => 'assigned', 'reason' => null, 'via' => 'from europepmc.org', 'book' => 'yrtest_held_book'],
    ];
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

    $bookId = app(YieldReportBook::class)->generate($root, 'YRTest Neoliberalism', yrResults());

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
    $bookId = app(YieldReportBook::class)->generate($root, 'YRTest Yield', yrResults());

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

    // The success is a citation whose title links to the held book.
    expect($html)->toContain('href="/yrtest_held_book"');

    // Failures come before the harvested section.
    $failPos = strpos($plain, 'Failed to Harvest');
    $gotPos = strpos($plain, "\nHarvested");
    expect($failPos)->toBeLessThan($gotPos);
});

test('re-running accumulates into the SAME living report (a later run never clobbers an earlier one)', function () {
    $root = yrSeedBook(['title' => 'YRTest Rerun', 'creator' => 'yrtest_user']);
    $svc = app(YieldReportBook::class);

    // First run: 1 success + 2 non-successes (a cloudflare failure + a deferred).
    $first = $svc->generate($root, 'YRTest Rerun', yrResults());

    // A second, SMALLER run brings home ONE new work (a different canonical) —
    // it must MERGE in, not replace: the first run's failures + success survive.
    $newWork = ['canonical_source_id' => (string) \Illuminate\Support\Str::uuid(), 'title' => 'A Newly Harvested Work', 'author' => 'New, Author', 'year' => 2021, 'type' => 'book', 'status' => 'assigned', 'reason' => null, 'via' => 'from arxiv.org', 'book' => 'yrtest_new_book'];
    $second = $svc->generate($root, 'YRTest Rerun', [$newWork]);
    expect($second)->toBe($first); // same living report book

    // Exactly one report row for this root.
    expect(yrDb()->table('library')->where('creator', 'yrtest_user')->whereRaw("raw_json->>'report_of' = ?", [$root])->count())->toBe(1);

    // The union carries BOTH runs: the original failure section stays, and the
    // new success is added alongside the original success.
    $plain = yrDb()->table('nodes')->where('book', $first)->orderBy('startLine')->pluck('plainText')->implode("\n");
    expect($plain)->toContain('Failed to Harvest');   // first run's failures preserved
    expect($plain)->toContain('Harvested');
    expect($plain)->toContain('A Newly Harvested Work'); // second run merged in
    expect($plain)->toContain('Accumulation on a World Scale'); // first run's success still there
});

test('a later run UPGRADES a previously-failed canonical to harvested', function () {
    $root = yrSeedBook(['title' => 'YRTest Upgrade', 'creator' => 'yrtest_user']);
    $svc = app(YieldReportBook::class);

    $cid = (string) \Illuminate\Support\Str::uuid();
    // First run: this canonical FAILED (cloudflare).
    $svc->generate($root, 'YRTest Upgrade', [
        ['canonical_source_id' => $cid, 'title' => 'The Upgraded Text', 'author' => 'X', 'year' => 2019, 'type' => 'journal-article', 'status' => 'fetch_failed', 'reason' => 'cloudflare_block', 'via' => null, 'book' => null],
    ]);
    // Second run: SAME canonical now succeeds → moves Failed → Harvested.
    $book = $svc->generate($root, 'YRTest Upgrade', [
        ['canonical_source_id' => $cid, 'title' => 'The Upgraded Text', 'author' => 'X', 'year' => 2019, 'type' => 'journal-article', 'status' => 'assigned', 'reason' => null, 'via' => 'from europepmc.org', 'book' => 'yrtest_upgraded'],
    ]);

    $html = yrDb()->table('nodes')->where('book', $book)->orderBy('startLine')->pluck('content')->implode("\n");
    // It is now a harvested citation linking to the held version, not a failure.
    expect($html)->toContain('href="/yrtest_upgraded"');
    // The union has exactly one entry for that canonical (not duplicated).
    $union = json_decode(yrDb()->table('library')->where('book', $book)->value('raw_json'), true)['cumulative_results'];
    expect(collect($union)->where('canonical_source_id', $cid)->count())->toBe(1);
    expect(collect($union)->firstWhere('canonical_source_id', $cid)['status'])->toBe('assigned');
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
    yrDb()->table('nodes')->insert(['book' => $oldId, 'startLine' => 1, 'chunk_id' => 0, 'node_id' => $oldId . '_r1', 'content' => '<p>old</p>', 'plainText' => 'old', 'type' => 'p', 'raw_json' => '{}', 'created_at' => now(), 'updated_at' => now()]);
    $shelfId = (string) Str::uuid();
    yrDb()->table('shelves')->insert(['id' => $shelfId, 'creator' => 'yrtest_user', 'name' => 'YRTest Shelf', 'slug' => 'yrtest-shelf-' . Str::random(6), 'visibility' => 'private', 'default_sort' => 'recent', 'created_at' => now(), 'updated_at' => now()]);
    yrDb()->table('shelf_items')->insert(['shelf_id' => $shelfId, 'book' => $oldId, 'added_at' => now()]);

    $newId = app(YieldReportBook::class)->generate($root, 'YRTest Purge', yrResults());

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
