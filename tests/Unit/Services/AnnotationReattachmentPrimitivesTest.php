<?php

/**
 * The pure text primitives under AnnotationReattachmentService: the
 * normalizer's offset map must round-trip normalized match positions back to
 * exact RAW character offsets (that is what makes reattached charData
 * correct), and the trigram scorer must rank same-ish paragraphs above
 * different ones.
 */

use App\Services\Annotations\AnnotationReattachmentService as S;

test('normalize collapses whitespace, strips markers, lowercases — map points at raw chars', function () {
    $raw = "The  Quick\u{00A0}\u{200B}Brown [12] Fox\u{2019}s ↗ jump\u{00B9}";
    $n = S::normalize($raw);

    expect($n['text'])->toBe("the quick brown fox's jump");
    // Every map entry must point at a raw index whose char "explains" the
    // normalized char. Spot-check the two ends.
    expect(mb_substr($raw, $n['map'][0], 1))->toBe('T');
    $lastRaw = mb_substr($raw, $n['map'][mb_strlen($n['text']) - 1], 1);
    expect($lastRaw)->toBe('p'); // superscript ¹ was stripped, 'p' is last real char
});

test('offset map recovers exact raw spans through normalization', function () {
    $raw = 'An important claim[1] that scholars dispute.';
    $n = S::normalize($raw);

    // Find the normalized phrase, map back, and carve the raw text.
    $needle = 'claim that scholars';
    $pos = mb_strpos($n['text'], $needle);
    expect($pos)->not->toBeFalse();
    $rawStart = $n['map'][$pos];
    $rawEnd = $n['map'][$pos + mb_strlen($needle) - 1] + 1;
    expect(mb_substr($raw, $rawStart, $rawEnd - $rawStart))->toBe('claim[1] that scholars');
});

test('findInText prefers the occurrence nearest the old offset', function () {
    $text = 'echo one echo two echo three';
    // Old anchor was near offset 18 → the third "echo" (index 18).
    [$start, $end, $how] = S::findInText('echo', $text, 18);
    expect($start)->toBe(18);
    expect($how)->toBe('raw');
});

test('findInText falls back to normalized matching and maps offsets home', function () {
    $segment = 'important claim[1] that';
    $text = "An important claim\u{00B9} that scholars dispute.";
    [$start, $end, $how] = S::findInText($segment, $text);

    expect($how)->toBe('normalized');
    expect(mb_substr($text, $start, $end - $start))->toContain('important claim');
});

test('trigram jaccard: same-ish text scores high, different text low', function () {
    $a = S::trigrams(S::normalize('The political economy of scholarly publishing considered.')['text']);
    $b = S::trigrams(S::normalize('The political economy of scholarly publishing considered!')['text']);
    $c = S::trigrams(S::normalize('An utterly unrelated sentence about marine biology.')['text']);

    expect(S::jaccard($a, $b))->toBeGreaterThan(0.8);
    expect(S::jaccard($a, $c))->toBeLessThan(0.2);
    expect(S::jaccard([], $a))->toBe(0.0);
});

test('matchNodes: exact buckets consume in order; fuzzy respects monotonicity', function () {
    $old = ['o1' => 'Twin paragraph.', 'o2' => 'Middle text block, quite distinct.', 'o3' => 'Twin paragraph.'];
    $oldIndex = ['o1' => 0, 'o2' => 1, 'o3' => 2];
    $new = [
        ['node_id' => 'n1', 'startLine' => 1.0, 'plainText' => 'Twin paragraph.'],
        ['node_id' => 'n2', 'startLine' => 2.0, 'plainText' => 'Middle text block, quite distinct!'], // punct drift → fuzzy
        ['node_id' => 'n3', 'startLine' => 3.0, 'plainText' => 'Twin paragraph.'],
    ];

    $match = S::matchNodes(['o1', 'o2', 'o3'], $old, $oldIndex, 3, $new);

    expect($match['o1'])->toBe(0);
    expect($match['o3'])->toBe(2);
    expect($match['o2'])->toBe(1); // fuzzy, boxed between the exact twins
});
