<?php

/**
 * QuoteLocator — find a quote in the cited book's nodes and return it in
 * hypercites.charData shape. Pure over node arrays; no DB.
 */

use App\Services\Hypercites\QuoteLocator;

function qlNode(string $id, string $plain): object
{
    return (object) ['node_id' => $id, 'plainText' => $plain];
}

test('an exact single-node match returns raw offsets and method exact', function () {
    $quote = 'the commons is not a tragedy but a shared achievement';
    $nodes = [
        qlNode('n1', 'Intro paragraph without the passage.'),
        qlNode('n2', 'In sum, ' . $quote . ' for those who build it.'),
    ];

    $hit = (new QuoteLocator)->locate($nodes, $quote);

    expect($hit)->not->toBeNull();
    expect($hit['method'])->toBe('exact');
    expect($hit['score'])->toBe(1.0);
    expect($hit['occurrences'])->toBe(1);
    expect($hit['node_ids'])->toBe(['n2']);
    $span = $hit['char_data']['n2'];
    expect(mb_substr($nodes[1]->plainText, $span['charStart'], $span['charEnd'] - $span['charStart']))
        ->toBe($quote);
});

test('curly-quote and dash drift in the source still matches, as normalized', function () {
    // The citing article straightened what the cited text set in curly quotes + em dash.
    $quoteAsCited = "governance \u{2014} real governance \u{2014} is \u{201C}built by users\u{201D} in every case that lasted";
    $quoteAsQuoted = 'governance - real governance - is "built by users" in every case that lasted';
    $nodes = [qlNode('n1', 'Preamble. ' . $quoteAsCited . ' Postamble.')];

    $hit = (new QuoteLocator)->locate($nodes, $quoteAsQuoted);

    expect($hit)->not->toBeNull();
    expect($hit['method'])->toBe('normalized');
    $span = $hit['char_data']['n1'];
    expect(mb_substr($nodes[0]->plainText, $span['charStart'], $span['charEnd'] - $span['charStart']))
        ->toBe($quoteAsCited);
});

test('multiple occurrences are counted — the ambiguity signal that blocks auto-approve', function () {
    $quote = 'a repeated formulation used more than once in the text of this work';
    $nodes = [
        qlNode('n1', 'First: ' . $quote . '.'),
        qlNode('n2', 'Second: ' . $quote . '.'),
    ];

    $hit = (new QuoteLocator)->locate($nodes, $quote);

    expect($hit['occurrences'])->toBe(2);
});

test('a quote straddling two adjacent nodes is found and split per node', function () {
    $partA = 'the first half of a long quotation that ends mid-thought';
    $partB = 'and the second half that completes it in the next paragraph';
    $nodes = [
        qlNode('n1', 'Lead-in text. ' . $partA),
        qlNode('n2', $partB . ' Trailing text.'),
    ];

    $hit = (new QuoteLocator)->locate($nodes, $partA . ' ' . $partB);

    expect($hit)->not->toBeNull();
    expect($hit['node_ids'])->toBe(['n1', 'n2']);
    $a = $hit['char_data']['n1'];
    $b = $hit['char_data']['n2'];
    expect(mb_substr($nodes[0]->plainText, $a['charStart'], $a['charEnd'] - $a['charStart']))->toBe($partA);
    expect(mb_substr($nodes[1]->plainText, $b['charStart'], $b['charEnd'] - $b['charStart']))->toBe($partB);
});

test('OCR-grade noise falls through to the fuzzy stage and scores under 1', function () {
    $quote = 'institutions for collective action emerge where communication is cheap and monitoring is mutual';
    $noisy = 'institutions for collective actlon emerge where cornmunication is cheap and monitoring is mutual';
    $nodes = [
        qlNode('n1', 'Unrelated opening node about entirely different things and topics.'),
        qlNode('n2', 'Mid text. ' . $noisy . ' More text after.'),
    ];

    $hit = (new QuoteLocator)->locate($nodes, $quote);

    expect($hit)->not->toBeNull();
    expect($hit['method'])->toBe('fts_fuzzy');
    expect($hit['score'])->toBeLessThan(1.0);
    expect($hit['score'])->toBeGreaterThanOrEqual(0.85);
    expect($hit['node_ids'])->toBe(['n2']);
});

test('a quote that is simply not in the book returns null', function () {
    $nodes = [qlNode('n1', 'This work never says anything remotely like the sought passage.')];

    expect((new QuoteLocator)->locate($nodes, 'a completely absent quotation about maritime law and its discontents'))
        ->toBeNull();
});
