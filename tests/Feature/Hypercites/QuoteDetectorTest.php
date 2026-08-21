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

test("a possessive plural inside a single-quoted span offers BOTH readings, longest first", function () {
    // Verbatim from GSCJ (single-quote house style): the apostrophe after
    // `learners` is followed by a space — character-identical to the real
    // closing mark after `perspective`. Local analysis cannot choose; the
    // detector must hand both readings up so the cited text can decide.
    $title = "(Dis)connection between curriculum, pedagogy and learners' lived experience "
        . "in Nepal's secondary schools: an environmental (in)justice perspective";
    $plain = "In '{$title}', for example, the authors (Paudel et al, 2024) show that the curriculum.";
    $marker = mb_strpos($plain, '(Paudel');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), null, null);

    expect($hit)->not->toBeNull();
    expect($hit['candidates'])->toHaveCount(2);
    expect($hit['candidates'][0])->toBe($title);                       // full title first
    expect($hit['candidates'][1])->toBe('(Dis)connection between curriculum, pedagogy and learners');
    // `Nepal's` never closes — an apostrophe followed by a letter is internal.
    foreach ($hit['candidates'] as $candidate) {
        expect($candidate)->not->toBe('(Dis)connection between curriculum, pedagogy and learners\' lived experience in Nepal');
    }
});

test('a double-quoted span still stops at its first closer', function () {
    $quote = 'the commons is not a tragedy but a shared achievement';
    $plain = 'He said "' . $quote . '" and then "a second quotation entirely" (Ostrom 1990).';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), null, null);

    expect($hit['candidates'])->toContain($quote);
    // No candidate may swallow the closer and run into the next quotation.
    foreach ($hit['candidates'] as $candidate) {
        expect($candidate)->not->toContain('and then');
    }
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

test('a quote belongs to the marker that attributes it, not a later citation in the sentence', function () {
    // Verbatim shape from GSCJ. The quote is attributed to Mehta; Srivastava
    // is cited later in the same paragraph AND their article quotes Mehta too
    // — so without the clamp the quote located in Srivastava's text and
    // produced a hypercite claiming the words were Srivastava's.
    $quote = 'reflexive process involving both a critique of the existing social '
        . 'arrangements/status quo and the search for alternatives';
    $plain = "In TAPESTRY, praxis is understood as a '{$quote}' (Mehta et al, 2021a: 112). "
        . 'The articles in this collection (especially Srivastava et al, 2026) unpack the dynamics.';
    $mehta = mb_strpos($plain, 'Mehta et al');
    $srivastava = mb_strpos($plain, 'Srivastava et al');

    $detector = new QuoteDetector;
    $markers = [$mehta, $srivastava];

    // The attributing marker — the one FOLLOWING the quote — gets it…
    $hit = $detector->detect($plain, $mehta, qdNode('n1', $plain), null, null, $markers);
    expect($hit)->not->toBeNull();
    expect($hit['text'])->toBe($quote);

    // …and the later citation gets nothing.
    $wrong = $detector->detect($plain, $srivastava, qdNode('n1', $plain), null, null, $markers);
    expect($wrong)->toBeNull();
});

test('a marker AFTER the quote beats a narrative citation before it', function () {
    // Same GSCJ paragraph: "Masaka (2019) … needs to go beyond 'QUOTE'
    // (Keet, 2014: 27) to involve…" — the words are Keet's, not Masaka's.
    $quote = 'simplified arguments on knowledge inclusivity and epistemological pluralism';
    $plain = "Masaka (2019) writing about decolonising curricula explains that recognition "
        . "needs to go beyond '{$quote}' (Keet, 2014: 27) to involve genuine acknowledgement.";
    $masaka = mb_strpos($plain, 'Masaka (2019)');
    $keet = mb_strpos($plain, 'Keet, 2014');
    $markers = [$masaka, $keet];

    $detector = new QuoteDetector;
    expect($detector->detect($plain, $keet, qdNode('n1', $plain), null, null, $markers)['text'])->toBe($quote);
    expect($detector->detect($plain, $masaka, qdNode('n1', $plain), null, null, $markers))->toBeNull();
});

test('a narrative citation claims its quote when nothing follows it', function () {
    // "Author (2026) … a critique of 'QUOTE' (IMT)." — no marker after the
    // quote, so the preceding narrative citation owns it.
    $quote = 'Inclusive Masculinity Theory and its liberal Western discourse';
    $plain = "Lawton-Westerland's (2026) article sets out a critique of '{$quote}' (IMT). He argues further.";
    $marker = mb_strpos($plain, "Lawton-Westerland's");

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), null, null, [$marker]);

    expect($hit)->not->toBeNull();
    expect($hit['text'])->toBe($quote);
});

test('co-citations at the same offset both own the quote', function () {
    // "(A 2020; B 2021)" — CitationParser records both refIds at ONE offset.
    $quote = 'the commons is not a tragedy but a shared achievement of governance';
    $plain = "They write '{$quote}' (Ostrom 1990; Bhambra 2022).";
    $marker = mb_strpos($plain, '(Ostrom 1990');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), null, null, [$marker, $marker]);

    expect($hit)->not->toBeNull();
    expect($hit['text'])->toBe($quote);
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
