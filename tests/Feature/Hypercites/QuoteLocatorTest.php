<?php

/**
 * QuoteLocator — find a quote in the cited book's nodes and return it in
 * hypercites.charData shape. Pure over node arrays; no DB.
 */

use App\Services\Hypercites\QuoteLocator;

function qlNode(string $id, string $plain, ?string $type = null): object
{
    return (object) ['node_id' => $id, 'plainText' => $plain, 'type' => $type];
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

// ── Every location, ranked (the occurrence picker's data) ──

test('locateAll returns one location per occurrence, and locate() still reports the top one', function () {
    $quote = 'a repeated formulation used more than once in the text of this work';
    $nodes = [
        qlNode('n1', 'First: ' . $quote . '.'),
        qlNode('n2', 'Second: ' . $quote . '.'),
        qlNode('n3', 'Third: ' . $quote . '.'),
    ];

    $locator = new QuoteLocator;
    $all = $locator->locateAll($nodes, $quote);

    expect($all)->toHaveCount(3);
    expect(array_column($all, 'node_ids'))->toBe([['n1'], ['n2'], ['n3']]); // document order, nothing to demote

    // The single-result API is the top location plus the count.
    $hit = $locator->locate($nodes, $quote);
    expect($hit['occurrences'])->toBe(3);
    expect($hit['node_ids'])->toBe($all[0]['node_ids']);
    expect($hit['char_data'])->toBe($all[0]['char_data']);
});

test('the front-matter occurrence is demoted below the body one', function () {
    // The live failure: a quote of "meaningful and equitable" put the reviewer
    // on the cited paper's own title block — first in document order, and never
    // the passage anyone was quoting.
    $title = 'Promoting meaningful and equitable relationships? Exploring the UK\'s '
        . 'Global Challenges Research Fund funding criteria';
    $quote = 'meaningful and equitable';
    $nodes = [
        qlNode('front', "Grieve, T., & Mitchell, R. (2020). {$title}. European Journal of Development Research."),
        qlNode('body', "GCRF explicitly called for '{$quote}' research partnerships across the programme."),
    ];

    $all = (new QuoteLocator)->locateAll($nodes, $quote, citedTitle: $title);

    expect($all)->toHaveCount(2);
    expect($all[0]['node_ids'])->toBe(['body']);   // ranked first despite coming second
    expect($all[1]['node_ids'])->toBe(['front']);
});

test('front-matter ranking works when nodes.type is NULL throughout', function () {
    // A Taylor & Francis capture stores type NULL on every node, so a
    // heading-only heuristic sees nothing to demote — title containment is what
    // actually carries this case.
    $title = 'Non-aligned common front: strategic imaginaries of the New International Economic Order';
    $quote = 'strategic imaginaries';
    $nodes = [
        qlNode('t', $title),
        qlNode('meta', 'Pages 891-901 | Received 13 May 2024, Accepted 26 Aug 2024'),
        qlNode('body', "The G77's {$quote} were never a single programme, as the record shows."),
    ];

    $all = (new QuoteLocator)->locateAll($nodes, $quote, citedTitle: $title);

    expect($all[0]['node_ids'])->toBe(['body']);
    foreach ($nodes as $n) {
        expect($n->type)->toBeNull(); // the premise of the test
    }
});

test('a heading occurrence is demoted', function () {
    $quote = 'funder constraints on partnership';
    $nodes = [
        qlNode('h', 'Funder constraints on partnership', 'h2'),
        qlNode('p', "We turn now to the funder constraints on partnership that shaped the fund."),
    ];

    $all = (new QuoteLocator)->locateAll($nodes, $quote);

    expect($all[0]['node_ids'])->toBe(['p']);
    expect($all[1]['node_ids'])->toBe(['h']);
});

test('a title too short to be distinctive does not demote the whole book', function () {
    // "Peer Review 2027" occurs throughout its own article; demoting on it would
    // rank every real occurrence last.
    $title = 'Peer Review 2027';
    $quote = 'peer review 2027 argues that';
    $nodes = [
        qlNode('a', 'In Peer Review 2027 argues that the practice must change.'),
        qlNode('b', 'Later, Peer Review 2027 argues that reviewers need support.'),
    ];

    $all = (new QuoteLocator)->locateAll($nodes, $quote, citedTitle: $title);

    expect($all)->toHaveCount(2);
    expect($all[0]['node_ids'])->toBe(['a']); // untouched document order
});

test('fuzzy returns one location per real occurrence, not one per sliding window', function () {
    // The window steps by segLen/10, so a single occurrence clears the accept
    // threshold ~10 times over. Undeduped, one occurrence would fill the picker.
    $quote = 'institutions for collective action emerge where communication is cheap and monitoring is mutual';
    $noisy = 'institutions for collective actlon emerge where cornmunication is cheap and monitoring is mutual';
    $nodes = [
        qlNode('n1', 'Opening remarks that share no vocabulary with the sought passage at all.'),
        qlNode('n2', 'Mid text. ' . $noisy . ' More text after.'),
    ];

    $all = (new QuoteLocator)->locateAll($nodes, $quote);

    expect($all)->toHaveCount(1);
    expect($all[0]['method'])->toBe('fts_fuzzy');
    expect($all[0]['node_ids'])->toBe(['n2']);
});

test('the stored list is capped, and the reported count matches what was kept', function () {
    config()->set('hypercites.max_match_locations', 3);
    $quote = 'a phrase so generic it recurs throughout the entire work in question';
    $nodes = [];
    foreach (range(1, 8) as $i) {
        $nodes[] = qlNode("n{$i}", "Section {$i}: {$quote}.");
    }

    $locator = new QuoteLocator;

    expect($locator->locateAll($nodes, $quote))->toHaveCount(3);
    // The picker renders "x / occurrences", so the two must never disagree.
    expect($locator->locate($nodes, $quote)['occurrences'])->toBe(3);
});
