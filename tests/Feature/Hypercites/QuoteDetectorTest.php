<?php

/**
 * QuoteDetector — pure text analysis: does an in-text citation carry a direct
 * quote, and which one? Lives under Feature (not Unit) because the thresholds
 * read config() and Pest binds the Laravel TestCase here.
 */

use App\Services\Hypercites\QuoteDetector;

function qdNode(string $id, string $plain, bool $blockquote = false): array
{
    return ['node_id' => $id, 'plainText' => $plain, 'is_blockquote' => $blockquote];
}

test('an inline double-quoted span near the marker is detected, marks stripped', function () {
    $quote = 'the commons is not a tragedy but a shared achievement';
    $plain = 'As argued, "' . $quote . '" (Ostrom 1990).';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), null, null);

    expect($hit)->not->toBeNull();
    expect($hit['kind'])->toBe('inline');
    expect($hit['text'])->toBe($quote);
    expect($hit['node_id'])->toBe('n1');
});

test('curly quotes work too', function () {
    $quote = 'governing shared resources demands institutions built by their users';
    $plain = "They write, \u{201C}{$quote}\u{201D} (Smith 2020), which stands.";
    $marker = mb_strpos($plain, '(Smith');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), null, null);

    expect($hit)->not->toBeNull();
    expect($hit['text'])->toBe($quote);
});

test('a short scare-quoted term is not a quote', function () {
    $plain = 'The so-called "commons" was reframed entirely by later scholarship (Ostrom 1990).';
    $marker = mb_strpos($plain, '(Ostrom');

    expect((new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), null, null))->toBeNull();
});

test('a quoted span in a DIFFERENT sentence far from the marker is not attributed', function () {
    $quote = 'a long quotation that belongs to an entirely different citation nearby';
    $plain = '"' . $quote . '" (Jones 2001). ' . str_repeat('Unrelated filler sentence follows here. ', 12)
        . 'And a bare claim with no quote at all (Ostrom 1990).';
    $marker = mb_strpos($plain, '(Ostrom');

    expect((new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), null, null))->toBeNull();
});

test('a marker inside a blockquote node claims the blockquote', function () {
    $plain = 'Long quoted passage lifted wholesale from the cited work. (Ostrom 1990)';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('bq', $plain, blockquote: true), null, null);

    expect($hit)->not->toBeNull();
    expect($hit['kind'])->toBe('blockquote');
    expect($hit['node_id'])->toBe('bq');
});

test('a marker in the first sentence AFTER a blockquote claims the preceding blockquote', function () {
    $bqText = 'An extended passage reproduced verbatim from the source, well past any length threshold.';
    $plain = 'So argues Ostrom (Ostrom 1990), and the field followed. More prose here.';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect(
        $plain,
        $marker,
        qdNode('n2', $plain),
        qdNode('bq1', $bqText, blockquote: true),
        null,
    );

    expect($hit)->not->toBeNull();
    expect($hit['kind'])->toBe('blockquote');
    expect($hit['node_id'])->toBe('bq1');
    expect($hit['text'])->toBe($bqText);
});

test('a marker in the LAST sentence before a blockquote claims the following blockquote', function () {
    $bqText = 'The block quotation that the introducing sentence announces, long enough to count.';
    $plain = 'As Ostrom puts it (Ostrom 1990):';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect(
        $plain,
        $marker,
        qdNode('n1', $plain),
        null,
        qdNode('bq2', $bqText, blockquote: true),
    );

    expect($hit)->not->toBeNull();
    expect($hit['node_id'])->toBe('bq2');
});

test('a marker mid-paragraph does NOT claim a neighbouring blockquote', function () {
    $bqText = 'Some other quotation belonging to a different citation entirely, past the threshold.';
    $plain = 'First sentence sets the scene. A middle claim cites someone (Ostrom 1990). A final sentence closes.';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect(
        $plain,
        $marker,
        qdNode('n2', $plain),
        qdNode('bq1', $bqText, blockquote: true),
        null,
    );

    expect($hit)->toBeNull();
});

test('an inline quote wins over blockquote attribution when both are plausible', function () {
    $quote = 'an inline quotation immediately beside the citation marker, long enough';
    $plain = '"' . $quote . '" (Ostrom 1990) opens the paragraph.';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect(
        $plain,
        $marker,
        qdNode('n2', $plain),
        qdNode('bq1', 'A neighbouring blockquote of respectable length sitting just before it.', blockquote: true),
        null,
    );

    expect($hit['kind'])->toBe('inline');
    expect($hit['text'])->toBe($quote);
});
