<?php

/**
 * The single-citation claims merge: target rows (parent + ::subN siblings)
 * are replaced IN PLACE (fresh rows splice at the first removed index so the
 * file keeps document order), an absent target appends, and a refId that
 * merely shares a prefix (smith2020 vs smith2020b) is never touched.
 */

use App\Services\CitationStudy\ClaimsPatcher;

function row(string $refId, string $marker = ''): array
{
    return ['referenceId' => $refId, 'truth_claim' => "claim {$refId} {$marker}"];
}

it('replaces the parent and its ::subN siblings in place', function () {
    $base = [row('a1'), row('target'), row('target::sub1'), row('z9')];
    $fresh = [row('target', 'fresh'), row('target::sub1', 'fresh'), row('target::sub2', 'fresh')];

    $out = (new ClaimsPatcher)->patch($base, $fresh, 'target');

    expect($out['replaced'])->toBe(2)
        ->and($out['inserted'])->toBe(3)
        ->and(array_column($out['claims'], 'referenceId'))
        ->toBe(['a1', 'target', 'target::sub1', 'target::sub2', 'z9'])
        ->and($out['claims'][1]['truth_claim'])->toContain('fresh');
});

it('splices at the first removed index when target rows were scattered', function () {
    $base = [row('target'), row('a1'), row('target::sub1'), row('z9')];
    $fresh = [row('target', 'fresh')];

    $out = (new ClaimsPatcher)->patch($base, $fresh, 'target');

    expect(array_column($out['claims'], 'referenceId'))->toBe(['target', 'a1', 'z9'])
        ->and($out['replaced'])->toBe(2);
});

it('appends when the base run had no rows for the citation', function () {
    $base = [row('a1'), row('z9')];
    $fresh = [row('target', 'fresh'), row('target::sub1', 'fresh')];

    $out = (new ClaimsPatcher)->patch($base, $fresh, 'target');

    expect($out['replaced'])->toBe(0)
        ->and(array_column($out['claims'], 'referenceId'))->toBe(['a1', 'z9', 'target', 'target::sub1']);
});

it('handles multi-node fan-out: several base rows for one refId all replaced', function () {
    $base = [row('a1'), row('target', 'node1'), row('b2'), row('target', 'node2')];
    $fresh = [row('target', 'n1'), row('target', 'n2'), row('target', 'n3')];

    $out = (new ClaimsPatcher)->patch($base, $fresh, 'target');

    expect($out['replaced'])->toBe(2)->and($out['inserted'])->toBe(3)
        ->and(array_column($out['claims'], 'referenceId'))
        ->toBe(['a1', 'target', 'target', 'target', 'b2']);
});

it('never claims a refId that merely shares a prefix', function () {
    $base = [row('smith2020'), row('smith2020b'), row('smith2020::sub1')];
    $fresh = [row('smith2020', 'fresh')];

    $out = (new ClaimsPatcher)->patch($base, $fresh, 'smith2020');

    expect($out['replaced'])->toBe(2) // smith2020 + its ::sub1, NOT smith2020b
        ->and(array_column($out['claims'], 'referenceId'))->toBe(['smith2020', 'smith2020b']);
});

it('refuses fresh rows carrying a foreign referenceId', function () {
    expect(fn () => (new ClaimsPatcher)->patch([row('a1')], [row('other')], 'target'))
        ->toThrow(InvalidArgumentException::class, 'foreign referenceId');
});
