<?php

/**
 * QuoteDetector — pure text analysis: does an in-text citation carry a direct
 * quote, and which one? Lives under Feature (not Unit) because the thresholds
 * read config() and Pest binds the Laravel TestCase here.
 */

use App\Services\Hypercites\QuoteDetector;

function qdNode(string $id, string $plain, bool $blockquote = false, ?string $content = null): array
{
    return [
        'node_id'       => $id,
        'plainText'     => $plain,
        'content'       => $content ?? '',
        'is_blockquote' => $blockquote,
    ];
}

/**
 * A blockquote node as the pipeline really stores it: `content` is the HTML and
 * `plainText` is strip_tags of it — which, exactly like BeautifulSoup's
 * get_text(strip=True) upstream, joins `</p><p>` with NOTHING. Tests must not
 * hand-write a plainText with a separator the real column would never contain.
 */
function qdBlockquote(string $id, string $innerHtml): array
{
    $content = "<blockquote id=\"{$id}\">{$innerHtml}</blockquote>";

    return qdNode($id, strip_tags($content), blockquote: true, content: $content);
}

test('an inline double-quoted span near the marker is detected, marks stripped', function () {
    $quote = 'the commons is not a tragedy but a shared achievement';
    $plain = 'As argued, "' . $quote . '" (Ostrom 1990).';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], []);

    expect($hit)->not->toBeNull();
    expect($hit['kind'])->toBe('inline');
    expect($hit['text'])->toBe($quote);
    expect($hit['node_id'])->toBe('n1');
});

test('curly quotes work too', function () {
    $quote = 'governing shared resources demands institutions built by their users';
    $plain = "They write, \u{201C}{$quote}\u{201D} (Smith 2020), which stands.";
    $marker = mb_strpos($plain, '(Smith');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], []);

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

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], []);

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

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], []);

    expect($hit['candidates'])->toContain($quote);
    // No candidate may swallow the closer and run into the next quotation.
    foreach ($hit['candidates'] as $candidate) {
        expect($candidate)->not->toContain('and then');
    }
});

test('a short scare-quoted term is not a quote', function () {
    $plain = 'The so-called "commons" was reframed entirely by later scholarship (Ostrom 1990).';
    $marker = mb_strpos($plain, '(Ostrom');

    expect((new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], []))->toBeNull();
});

test('a quoted span in a DIFFERENT sentence far from the marker is not attributed', function () {
    $quote = 'a long quotation that belongs to an entirely different citation nearby';
    $plain = '"' . $quote . '" (Jones 2001). ' . str_repeat('Unrelated filler sentence follows here. ', 12)
        . 'And a bare claim with no quote at all (Ostrom 1990).';
    $marker = mb_strpos($plain, '(Ostrom');

    expect((new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], []))->toBeNull();
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
    $hit = $detector->detect($plain, $mehta, qdNode('n1', $plain), [], [], $markers);
    expect($hit)->not->toBeNull();
    expect($hit['text'])->toBe($quote);

    // …and the later citation gets nothing.
    $wrong = $detector->detect($plain, $srivastava, qdNode('n1', $plain), [], [], $markers);
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
    expect($detector->detect($plain, $keet, qdNode('n1', $plain), [], [], $markers)['text'])->toBe($quote);
    expect($detector->detect($plain, $masaka, qdNode('n1', $plain), [], [], $markers))->toBeNull();
});

test('a narrative citation claims its quote when nothing follows it', function () {
    // "Author (2026) … a critique of 'QUOTE' (IMT)." — no marker after the
    // quote, so the preceding narrative citation owns it.
    $quote = 'Inclusive Masculinity Theory and its liberal Western discourse';
    $plain = "Lawton-Westerland's (2026) article sets out a critique of '{$quote}' (IMT). He argues further.";
    $marker = mb_strpos($plain, "Lawton-Westerland's");

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], [], [$marker]);

    expect($hit)->not->toBeNull();
    expect($hit['text'])->toBe($quote);
});

test('co-citations at the same offset both own the quote', function () {
    // "(A 2020; B 2021)" — CitationParser records both refIds at ONE offset.
    $quote = 'the commons is not a tragedy but a shared achievement of governance';
    $plain = "They write '{$quote}' (Ostrom 1990; Bhambra 2022).";
    $marker = mb_strpos($plain, '(Ostrom 1990');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], [], [$marker, $marker]);

    expect($hit)->not->toBeNull();
    expect($hit['text'])->toBe($quote);
});

test('a marker inside a blockquote node claims the blockquote', function () {
    $plain = 'Long quoted passage lifted wholesale from the cited work. (Ostrom 1990)';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('bq', $plain, blockquote: true), [], []);

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
        [qdNode('bq1', $bqText, blockquote: true)],
        [],
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
        [],
        [qdNode('bq2', $bqText, blockquote: true)],
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
        [qdNode('bq1', $bqText, blockquote: true)],
        [],
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
        [qdNode('bq1', 'A neighbouring blockquote of respectable length sitting just before it.', blockquote: true)],
        [],
    );

    expect($hit['kind'])->toBe('inline');
    expect($hit['text'])->toBe($quote);
});

// ── Blockquote text cleaning ──
// Unlike an inline span, a blockquote has no marks saying where the borrowed
// words stop, so it arrives carrying the citing author's furniture. Every case
// below is a shape taken from the corpus; each one, left in, defeats
// QuoteLocator's substring stages and pushes the match onto the fuzzy path
// where the window slides off the true span.

test('the blockquote trailing attribution paren is stripped', function () {
    // Verbatim corpus shape: the block ends with its own citation.
    $quoted = 'Indexing where terms are assigned by human indexers according to '
        . 'their perception and understanding of the document content.';
    $node = qdBlockquote('bq', "<p>{$quoted}(Qin,2000, p. 166)</p>");

    expect((new QuoteDetector)->blockquoteText($node))->toBe($quoted);
});

test('the blockquote em-dash attribution line is stripped', function () {
    $quoted = 'Let us admit it, the settler knows perfectly well that no phraseology '
        . 'can be a substitute for reality.';
    $node = qdBlockquote('bq', "<p>{$quoted}-Franz Fanon, The Wretched of the Earth, 1963, p. 61</p>");

    expect((new QuoteDetector)->blockquoteText($node))->toBe($quoted);
});

test('a hyphenated final word is NOT mistaken for an attribution line', function () {
    // `-Federalists` has a capital after the dash, like a credit line — the
    // guards (preceded by space/punctuation, contains a comma or digit) are
    // what keep the word intact.
    $quoted = 'The argument was pressed hardest by the writers we now call the Anti-Federalists';
    $node = qdBlockquote('bq', "<p>{$quoted}</p>");

    expect((new QuoteDetector)->blockquoteText($node))->toBe($quoted);
});

test('paragraph joins inside a blockquote are repaired with a space', function () {
    // The bug in one line: plainText glues `</p><p>` with NOTHING, so the block
    // reads "…of value.The second…" — a word present in no source anywhere.
    $node = qdBlockquote('bq', '<p>A first paragraph of the quotation ending in value.</p>'
        . '<p>The second paragraph carries on from there.</p>');

    $text = (new QuoteDetector)->blockquoteText($node);

    expect($node['plainText'])->toContain('value.The second');   // what is stored
    expect($text)->toContain('value. The second');               // what is searched
    expect($text)->not->toContain('value.The second');
});

test('enclosing quote marks are stripped, straight and curly', function () {
    $quoted = 'As researchers who wish to develop a theory, we must identify problems central to our field';
    $detector = new QuoteDetector;

    expect($detector->blockquoteText(qdBlockquote('bq', "<p>'{$quoted}'</p>")))->toBe($quoted);
    expect($detector->blockquoteText(qdBlockquote('bq', "<p>\u{201C}{$quoted}\u{201D}</p>")))->toBe($quoted);
});

test('an attribution INSIDE the enclosing marks is stripped too', function () {
    $quoted = 'Citations only occur at the end of this cycle';
    $node = qdBlockquote('bq', "<p>'{$quoted} (Bollen, Van de Sompel, & Rodriguez,2008, p. 231)'</p>");

    expect((new QuoteDetector)->blockquoteText($node))->toBe($quoted);
});

test('a quotation is not amputated by a parenthetical that dominates it', function () {
    // The bound exists so a short block that is mostly a parenthetical keeps
    // its words rather than being stripped down to nothing.
    $node = qdBlockquote('bq', '<p>Value (understood here as socially necessary labour time expended)</p>');

    expect((new QuoteDetector)->blockquoteText($node))->toContain('socially necessary labour time');
});

test('a lifted figure caption is not treated as a quotation', function () {
    // ar5iv_preprocessor::lift_figures() emits EVERY figure caption as a
    // <blockquote> for its browser styling, so without this guard an arXiv
    // book's captions are claimed by any marker in the next paragraph.
    $caption = qdBlockquote('bq', '<p>Figure 3: Distribution of citation counts across the sampled corpus.</p>');
    $plain = 'The distribution is heavily skewed (Ostrom 1990), as others have found.';
    $marker = mb_strpos($plain, '(Ostrom');

    expect((new QuoteDetector)->blockquoteText($caption))->toBe('');
    expect((new QuoteDetector)->detect($plain, $marker, qdNode('n2', $plain), [$caption], []))->toBeNull();
});

test('a blockquote too short to be a quotation yields nothing', function () {
    $node = qdBlockquote('bq', '<p>Ibid.</p>');
    $plain = 'A claim resting on that source (Ostrom 1990), followed by more prose.';
    $marker = mb_strpos($plain, '(Ostrom');

    expect((new QuoteDetector)->detect($plain, $marker, qdNode('n2', $plain), [$node], []))->toBeNull();
});

// ── Blockquote runs ──

test('a contiguous run of blockquote siblings is one quotation, joined in document order', function () {
    // 100 corpus blockquote nodes sit beside another. Taking only the nearest
    // neighbour silently truncated the quote to its LAST paragraph.
    $run = [
        qdBlockquote('bq1', '<p>The first paragraph of a long quotation runs to here.</p>'),
        qdBlockquote('bq2', '<p>The second paragraph continues the same passage.</p>'),
        qdBlockquote('bq3', '<p>And the third brings it to a close.</p>'),
    ];
    $plain = 'So argues Ostrom (Ostrom 1990), and the field followed.';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n2', $plain), $run, []);

    expect($hit)->not->toBeNull();
    expect($hit['kind'])->toBe('blockquote');
    expect($hit['node_id'])->toBe('bq1');            // the run's FIRST node
    expect($hit['text'])->toBe('The first paragraph of a long quotation runs to here. '
        . 'The second paragraph continues the same passage. '
        . 'And the third brings it to a close.');
});

test('a run stops at the first non-blockquote node', function () {
    // Only the CONTIGUOUS run counts: an ordinary paragraph between the marker
    // and a further block ends the attribution.
    $window = [
        qdBlockquote('bq1', '<p>A block that belongs to some earlier citation entirely.</p>'),
        qdNode('p1', 'An ordinary intervening paragraph of the citing author.'),
        qdBlockquote('bq2', '<p>The block this marker actually introduces, long enough to count.</p>'),
    ];
    $plain = 'So argues Ostrom (Ostrom 1990), and the field followed.';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n2', $plain), $window, []);

    expect($hit['node_id'])->toBe('bq2');
    expect($hit['text'])->not->toContain('earlier citation');
});

test('a following run is joined the same way', function () {
    $run = [
        qdBlockquote('bq1', '<p>The opening paragraph the colon announces, long enough to count.</p>'),
        qdBlockquote('bq2', '<p>Its continuation in a sibling block element.</p>'),
    ];
    $plain = 'As Ostrom puts it (Ostrom 1990):';
    $marker = mb_strpos($plain, '(Ostrom');

    $hit = (new QuoteDetector)->detect($plain, $marker, qdNode('n1', $plain), [], $run);

    expect($hit['node_id'])->toBe('bq1');
    expect($hit['text'])->toContain('Its continuation');
});
