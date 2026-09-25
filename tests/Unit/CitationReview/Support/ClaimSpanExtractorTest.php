<?php

use App\Services\CitationReview\Support\ClaimSpanExtractor;

$x = fn() => new ClaimSpanExtractor();

test('preceding clause starts at the sentence boundary', function () use ($x) {
    $text = 'First sentence. Second clause here';
    $pos = mb_strlen($text);
    expect($x()->precedingClauseSpan($text, $pos, []))->toBe('Second clause here');
});

test('preceding clause clamps at the nearest earlier marker', function () use ($x) {
    $text = 'One marker A then more text B';
    $markerA = mb_strpos($text, 'A');
    $posB = mb_strpos($text, 'B');
    // Clamped at marker A (inclusive) — the span does NOT reach back to the
    // sentence start ('One marker …'), proving the marker-clamp fires.
    expect($x()->precedingClauseSpan($text, $posB, [$markerA]))->toBe('A then more text');
});

test('sentence at position includes text after the marker', function () use ($x) {
    $text = 'Alpha beta. Gamma^ delta epsilon. Zeta';
    $pos = mb_strpos($text, '^');
    expect($x()->sentenceAtPosition($text, $pos))->toBe('Gamma^ delta epsilon.');
});

// ------------------------------------------------------ sentence boundaries

test('an initial is not a sentence boundary', function () use ($x) {
    // The 2026-09-20 run split here and left Cox a two-word claim while the
    // sentence attributes one position to three named theorists.
    $text = 'From the imperialist Henry Kissinger (1982), to the theorist of embedded '
          . 'liberalism, John Ruggie (Bhagwati and Ruggie 1984), and the historical '
          . 'materialist Robert W. Cox (Cox 1981), all agreed. Next sentence here.';
    $pos = mb_strpos($text, '(Cox 1981') + 5;
    expect($x()->sentenceAtPosition($text, $pos))->toContain('Henry Kissinger')
        ->and($x()->sentenceAtPosition($text, $pos))->toEndWith('all agreed.')
        ->and($x()->sentenceAtPosition($text, $pos))->not->toContain('Next sentence');
});

test('a known abbreviation is not a sentence boundary', function () use ($x) {
    $text = 'Research on scraped data (e.g. Lomborg and Bechmann, 2014) is now routine. Done.';
    $pos = mb_strpos($text, '2014');
    expect($x()->sentenceAtPosition($text, $pos))->toBe(
        'Research on scraped data (e.g. Lomborg and Bechmann, 2014) is now routine.'
    );
});

test('a lower-case continuation is not a sentence boundary', function () use ($x) {
    $text = 'Reported in vol. 4 of the series. A real sentence follows.';
    $pos = mb_strpos($text, 'series');
    expect($x()->sentenceAtPosition($text, $pos))->toBe('Reported in vol. 4 of the series.');
});

test('a real boundary still splits', function () use ($x) {
    $text = 'The first claim stands alone. The second one is separate.';
    expect($x()->sentenceAtPosition($text, mb_strpos($text, 'second')))
        ->toBe('The second one is separate.');
});

// --------------------------------------------------- attributed quotations

/**
 * The c161 sentence, verbatim from chacko-2025-paste — two citations doing two
 * different jobs, which is the whole point of ownSegmentSpan.
 */
function c161Text(): string
{
    return "Doval's doctrine of the 'New India' is consistent with Hindutva precepts that "
         . "fashion India as a 'viśvaguru' (teacher of the world) (BJP, 2014: 40): 'We never "
         . 'became aggressors to serve our personal interests. We will surely fight, on our '
         . 'soil as well as on foreign soil, but not for our personal interests. But in the '
         . "interests of Parmarth [highest] spirituality' (Doval quoted in TNN, 2020). While "
         . 'the Hindutva movement often treats Sikhs as members of a sect of Hinduism.';
}

test('the citation closing a quotation owns the WHOLE quotation', function () use ($x) {
    $text = c161Text();
    $bjp = mb_strpos($text, '(BJP, 2014') + 6;
    $tnn = mb_strpos($text, '(Doval quoted in TNN, 2020') + 22;

    $span = $x()->ownSegmentSpan($text, $tnn, [$bjp, $tnn]);

    // The quote runs across three sentences; the span reaches back over all of
    // them, and stops dead at the previous citation.
    expect($span)->toStartWith("'We never became aggressors")
        ->and($span)->toEndWith("(Doval quoted in TNN, 2020).")
        ->and($span)->not->toContain('viśvaguru');
});

test('the citation BEFORE a quotation does not own it', function () use ($x) {
    $text = c161Text();
    $bjp = mb_strpos($text, '(BJP, 2014') + 6;
    $tnn = mb_strpos($text, '(Doval quoted in TNN, 2020') + 22;

    $span = $x()->ownSegmentSpan($text, $bjp, [$bjp, $tnn]);

    expect($span)->toBe(
        "Doval's doctrine of the 'New India' is consistent with Hindutva precepts that "
        . "fashion India as a 'viśvaguru' (teacher of the world) (BJP, 2014: 40)"
    );
});

test('scare quotes and apostrophes are not quotations', function () use ($x) {
    // "Doval's" and 'viśvaguru' both carry single quotes; neither is introduced
    // by punctuation, so neither can be mistaken for an attributed quotation.
    $text = c161Text();
    $bjp = mb_strpos($text, '(BJP, 2014') + 6;
    expect($x()->quotationClosedBy($text, $bjp, 0))->toBeNull();
});

test('a citation with no quotation before it gets its plain sentence', function () use ($x) {
    $text = 'The first claim stands alone (Smith, 2020). A second claim follows (Jones, 2021).';
    $smith = mb_strpos($text, '2020');
    $jones = mb_strpos($text, '2021');
    expect($x()->ownSegmentSpan($text, $jones, [$smith, $jones]))
        ->toBe('A second claim follows (Jones, 2021).');
});

test('double-quoted attributed quotations work the same way', function () use ($x) {
    $text = 'He put it bluntly: "The order is finished. Nothing replaces it." (Cox, 1981). '
          . 'The argument was influential.';
    $cox = mb_strpos($text, '1981');
    $span = $x()->ownSegmentSpan($text, $cox, [$cox]);
    expect($span)->toStartWith('"The order is finished.')
        ->and($span)->toContain('Nothing replaces it."');
});
