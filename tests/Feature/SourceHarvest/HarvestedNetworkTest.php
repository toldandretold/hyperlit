<?php

/**
 * HarvestEligibility::harvestedNetworkFor — the DURABLE "what has been
 * harvested" query behind the yield report's Harvested section. It walks the
 * citation network from a root over durable state (bibliography → canonical →
 * auto_version_book → that version book's bibliography → …), returning every
 * reached canonical that carries an auto_version_book, with BFS lineage. This
 * is the fix for "I press harvest again and it should report what's harvested":
 * the answer comes from the database, not from any run's bookkeeping.
 */

use App\Services\SourceHarvest\HarvestEligibility;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function hnDb()
{
    return DB::connection('pgsql_admin');
}

/** Seed a canonical; $versionBook (auto_version_book) marks it as harvested. */
function hnCanonical(string $title, ?string $versionBook = null): string
{
    $id = (string) Str::uuid();
    hnDb()->table('canonical_source')->insert([
        'id'                => $id,
        'title'             => $title,
        'author'            => 'HN Author',
        'year'              => 2020,
        'type'              => 'article',
        'is_oa'             => true,
        'openalex_id'       => 'W_HN_' . Str::random(8),
        'auto_version_book' => $versionBook,
    ]);
    return $id;
}

/** Link a book's bibliography to a canonical (a direct citation edge). */
function hnCite(string $book, string $canonicalId): void
{
    hnDb()->table('bibliography')->insert([
        'book'                => $book,
        'referenceId'         => 'Ref_hn_' . Str::random(6),
        'content'             => 'HN Reference',
        'canonical_source_id' => $canonicalId,
    ]);
}

afterEach(function () {
    hnDb()->table('bibliography')->where('book', 'like', 'hn\_%')->delete();
    hnDb()->table('canonical_source')->where('openalex_id', 'like', 'W_HN_%')->delete();
});

test('returns every durably-harvested canonical reachable from the root, with lineage', function () {
    // root cites C1 (harvested → hn_v1) and C2 (NOT harvested).
    $c1 = hnCanonical('Harvested Direct', 'hn_v1');
    $c2 = hnCanonical('Unharvested Direct', null);
    hnCite('hn_root', $c1);
    hnCite('hn_root', $c2);

    // The version book hn_v1 cites C3 (harvested → hn_v3) at the next level.
    $c3 = hnCanonical('Harvested Deep', 'hn_v3');
    hnCite('hn_v1', $c3);

    $network = app(HarvestEligibility::class)->harvestedNetworkFor('hn_root');
    $byId = collect($network)->keyBy('canonical_source_id');

    // C1: depth 1, parented to root, book = its version book, status assigned.
    expect($byId)->toHaveKey($c1);
    expect($byId[$c1]['depth'])->toBe(1);
    expect($byId[$c1]['parent_book'])->toBe('hn_root');
    expect($byId[$c1]['book'])->toBe('hn_v1');
    expect($byId[$c1]['status'])->toBe('assigned');
    expect($byId[$c1]['title'])->toBe('Harvested Direct');

    // C3: reached THROUGH the harvested version book — depth 2, parent hn_v1.
    expect($byId)->toHaveKey($c3);
    expect($byId[$c3]['depth'])->toBe(2);
    expect($byId[$c3]['parent_book'])->toBe('hn_v1');
    expect($byId[$c3]['book'])->toBe('hn_v3');

    // C2 is reachable but NOT harvested (no auto_version_book) — excluded.
    expect($byId)->not->toHaveKey($c2);

    expect($network)->toHaveCount(2);
});

test('is empty for a book whose citations are none of them harvested', function () {
    hnCite('hn_root', hnCanonical('Unharvested A', null));
    hnCite('hn_root', hnCanonical('Unharvested B', null));

    expect(app(HarvestEligibility::class)->harvestedNetworkFor('hn_root'))->toBe([]);
});

test('a cycle in the harvested network terminates (visited-book guard)', function () {
    // C1 harvested → hn_v1; hn_v1 cites C2 harvested → hn_root (back to start).
    $c1 = hnCanonical('Cycle One', 'hn_v1');
    hnCite('hn_root', $c1);
    $c2 = hnCanonical('Cycle Two', 'hn_root');
    hnCite('hn_v1', $c2);

    $network = app(HarvestEligibility::class)->harvestedNetworkFor('hn_root');

    // Both harvested canonicals are found; the walk does not loop forever.
    expect(collect($network)->pluck('canonical_source_id')->sort()->values()->all())
        ->toBe(collect([$c1, $c2])->sort()->values()->all());
});
