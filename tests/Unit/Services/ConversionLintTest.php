<?php

use App\Services\Conversion\ConversionLint;

/**
 * conversion:lint detectors, each pinned with the real shape it was written for and a
 * near-miss it must NOT fire on (a triage ranking full of false positives is ignored).
 */

function lintNode(string $line, string $html): array
{
    return ['startLine' => $line, 'content' => $html];
}

function detectors(array $result): array
{
    return array_column($result['findings'], 'detector');
}

it('flags a page-break fragment wrapped as a blockquote (7fa30289)', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<ul><li>Underrepresentation of alternative voices: Alternative voices are less heard or read on the Internet than Mainstream ones. The assignment of</li></ul>'),
        lintNode('200', '<blockquote><p>domain names (such as microsoft.com) has been commodified. Formerly the state-owned National Science Foundation was in control.</p></blockquote>'),
    ]);
    expect(detectors($r))->toBe(['fragment_blockquote']);
});

it('leaves a quotation introduced by a finished lead-in alone', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>Daya Thussu notes a telling paradox in the interview, one worth quoting at length:</p>'),
        lintNode('200', '<blockquote><p>Indira Gandhi was the prime minister of India and she had imposed a state of emergency.</p></blockquote>'),
    ]);
    expect(detectors($r))->toBe([]);
});

it('does not read URL, e-mail or glossary lines as split sentences', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>Department of Culture and Creative Industries, City University London marisol.sandoval@city.ac.uk</p>'),
        lintNode('200', '<p>http://www.city.ac.uk/arts-social-sciences/academic-staff-profiles/culture-and-creative-industries</p>'),
        lintNode('300', '<p>vk: value of resource number k within the network of all actors</p>'),
        lintNode('400', '<p>xki: interest of actor i in resource k within the network of all actors</p>'),
    ]);
    expect(detectors($r))->toBe([]);
});

it('flags a footnote whose OCR copy stayed in the body (7fa30289 note 7)', function () {
    $def = 'Marx formulated the general law of capitalistic accumulation in the following words';
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>an automatic tendency of absolute impoverishment<sup class="footnote-ref" fn-count-id="7" id="Fn7">7</sup> because</p>'),
        lintNode('200', "<p>7 {$def}: “The greater the social wealth…”</p>"),
    ], ['Fn7' => $def . ': “The greater the social wealth…”']);
    expect(detectors($r))->toBe(['body_footnote_twin']);
});

it('reports orphaned and missing definitions against the footnotes table', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>Text with a marker<sup class="footnote-ref" fn-count-id="1" id="Fn1">1</sup> and one without a def<sup class="footnote-ref" fn-count-id="2" id="Fn2">2</sup>.</p>'),
    ], ['Fn1' => 'First note.', 'Fn5' => 'It is telling that according to the official website of UNESCO (2016)…']);
    expect(detectors($r))->toEqualCanonicalizing(['orphan_definition', 'missing_definition']);
});

it('skips the stored Footnotes section and bibliography entries', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<h2>References</h2>'),
        lintNode('200', '<p><a class="bib-entry" id="x"></a>Fuchs, Christian. 2014. Digital Labour and Karl Marx. New York and</p>'),
        lintNode('300', '<p><a class="bib-entry" id="y"></a>london: Routledge, which is a lower-case continuation that is not a bug here.</p>'),
        lintNode('400', '<h2><a id="footnotes"></a>Footnotes</h2>'),
        lintNode('500', '<p><a fn-count-id="3" id="Fn3"></a>[^3]: This model of social self-organization was first introduced in</p>'),
        lintNode('600', '<p>elaborated in a number of further works, the definition continues lower-case here.</p>'),
    ], []);
    expect(detectors($r))->toBe([]);
});

it('flags heading shapes: lost marker digit, list lead-in colon, paragraph promoted', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<h2>1. Introduction1</h2>'),
        lintNode('200', '<h2>1. Introduction<sup class="footnote-ref" fn-count-id="1" id="Fn1">1</sup></h2>'),
        lintNode('300', '<h2>Aspects of emergence are:</h2>'),
        lintNode('400', '<h2>References:</h2>'),
        lintNode('500', '<h2>' . str_repeat('A sentence that goes on ', 8) . '</h2>'),
        lintNode('600', '<h1>' . str_repeat('A long article title is fine ', 8) . '</h1>'),
    ], ['Fn1' => 'An earlier version.']);
    expect(detectors($r))->toBe(['glued_heading_digit', 'colon_heading', 'long_heading']);
});

it('finds page chrome repeated across a journal, never bibliography tails or headings', function () {
    $lint = new ConversionLint;
    $cands = [];
    foreach (['a', 'b', 'c'] as $book) {
        $front = array_map(fn ($i) => lintNode((string) $i, "<p>Front matter line {$i} of book {$book}, which is skipped.</p>"), range(1, 10));
        $res = $lint->lintBook([
            ...$front,
            lintNode('90', '<p>Christian Fuchs</p>'),
            lintNode('100', '<h2>Conclusion</h2>'),
            lintNode('200', '<p>Body text that ends a paragraph properly. © Vienna University of Technology 2003.</p>'),
            lintNode('300', '<h2>References</h2>'),
            lintNode('400', '<p><a class="bib-entry" id="z"></a>Harvey, David. 2005. A Brief History of Neoliberalism. London: Verso.</p>'),
        ], []);
        $cands[$book] = $res['chrome_candidates'];
    }
    $leaks = $lint->chromeLeaks($cands);
    expect(array_keys($leaks))->toBe(['a', 'b', 'c'])
        ->and($leaks['a'])->toBe(['© Vienna University of Technology ####.']);
});

it('keys findings by excerpt so a reconvert (new node ids) compares cleanly', function () {
    $f = ['detector' => 'split_sentence', 'startLine' => '100', 'excerpt' => 'Some  Text'];
    $g = ['detector' => 'split_sentence', 'startLine' => '9900', 'excerpt' => 'some text'];
    expect(ConversionLint::key($f))->toBe(ConversionLint::key($g));
});

it('does not read a lettered list as a sentence cut in two (27e44104)', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>a) an abstraction from the physical properties of goods (their use-values),</p>'),
        lintNode('200', '<p>b) an abstraction from single labour activities so that social relations between commodities in exchange are established,</p>'),
        lintNode('300', '<p>(c) an abstraction from simple labour activities to more complex tasks, which is the third,</p>'),
        lintNode('400', '<p>iv. an abstraction from concrete labour altogether, and that is where the list ends.</p>'),
    ]);
    expect(detectors($r))->toBe([]);
});

it('locates an orphaned definition whose stored node has no anchor, by its text', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>Body text with no markers at all, ending properly.</p>'),
        lintNode('400', '<h2><a id="footnotes"></a>Footnotes</h2>'),
        lintNode('500', '<p>[^1]: A note that somebody points to, in principle.</p>'),
        lintNode('600', '<p>[^2]: http://www.example.org/working-papers/2012/a-long-address</p>'),
    ], ['Fn2' => 'http://www.example.org/working-papers/2012/a-long-address']);
    expect($r['findings'][0]['detector'])->toBe('orphan_definition')
        ->and($r['findings'][0]['startLine'])->toBe('600');
});

it('ends the definitions section at the next heading (9d0400c9)', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>Early text.</p>'),
        lintNode('200', '<h2><a id="footnotes"></a>Footnotes</h2>'),
        lintNode('300', '<p><a fn-count-id="5" id="Fn5"></a>[^5]: A note stranded mid-article.</p>'),
        lintNode('400', '<h3>3.3. The next section</h3>'),
        lintNode('500', '<p>Body text that calls a note<sup class="footnote-ref" fn-count-id="6" id="Fn6">6</sup> after the stray heading.</p>'),
        lintNode('600', '<p><a fn-count-id="6" id="Fn6"></a>[^6]: The note it calls.</p>'),
    ], ['Fn6' => 'The note it calls.']);
    expect(detectors($r))->toBe([]);
});

it('ends a mid-article definitions block at the first body paragraph that calls a note (f04989d6)', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>Early text calling a note<sup class="footnote-ref" fn-count-id="4" id="Fn4">4</sup> properly.</p>'),
        lintNode('200', '<h2><a id="footnotes"></a>Footnotes</h2>'),
        lintNode('300', '<p><a fn-count-id="4" id="Fn4"></a>[^4]: The note of the first section.</p>'),
        lintNode('400', '<p>The article simply carries on, with no heading, and calls another<sup class="footnote-ref" fn-count-id="10" id="Fn10">10</sup> note.</p>'),
        lintNode('900', '<p><a fn-count-id="10" id="Fn10"></a>[^10]: The later note it calls.</p>'),
    ], ['Fn4' => 'The note of the first section.', 'Fn10' => 'The later note it calls.']);
    expect(detectors($r))->toBe([]);
});

it('files an orphan the PDF has no marker for under its own unscored detector', function () {
    $nodes = [
        lintNode('100', '<p>Body text with no markers at all, ending properly.</p>'),
        lintNode('400', '<h2><a id="footnotes"></a>Footnotes</h2>'),
        lintNode('500', '<p>[^1]: A note whose marker the print never carried.</p>'),
        lintNode('600', '<p>[^2]: A note whose marker is in the PDF text.</p>'),
    ];
    $notes = ['Fn1' => 'A note whose marker the print never carried.', 'Fn2' => 'A note whose marker is in the PDF text.'];
    $verdicts = [
        ConversionLint::verdictHead($notes['Fn1']) => 'no_marker_in_layer',
        ConversionLint::verdictHead($notes['Fn2']) => 'marker_in_layer',
    ];
    $r = (new ConversionLint)->lintBook($nodes, $notes, ['unlinked' => $verdicts]);
    expect(detectors($r))->toBe(['orphan_unrecoverable', 'orphan_definition'])
        ->and(ConversionLint::score(['orphan_unrecoverable' => 9]))->toBe(0);
    // with no verdict on file every orphan is worth a look
    expect(detectors((new ConversionLint)->lintBook($nodes, $notes)))->toBe(['orphan_definition', 'orphan_definition']);
});

it('does not read a letter-keyed table legend as split sentences (294c2019)', function () {
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>Table 2: Distribution of the use of Marx\'s name in the main text of the articles</p>'),
        lintNode('200', '<p>a Provides a discussion using Marx\'s ideas throughout the article</p>'),
        lintNode('300', '<p>b The whole article is dedicated to Marx, to Marxist views and analysis</p>'),
        lintNode('400', '<p>c Uses Marx to provide a Marxist analysis of class, exploitation and media</p>'),
    ]);
    expect(detectors($r))->toBe([]);
    // a lone "a" + capital is still a fragment
    $r = (new ConversionLint)->lintBook([
        lintNode('100', '<p>The whole article, the author says, is in the end an attempt to give</p>'),
        lintNode('200', '<p>a Marxist analysis of class, of exploitation and of the media in general.</p>'),
    ]);
    expect(detectors($r))->toBe(['split_sentence']);
});

it('does not call a numbered section title a paragraph promoted to a heading (27e44104)', function () {
    $long = 'Are People who Argue for an Alternative Concept of Work Stalinist Labour Fetishists? Why We Need to Repeat William Morris and Herbert Marcuse in the Digital Labour Debate, Again and Again.';
    $r = (new ConversionLint)->lintBook([lintNode('100', "<h2>4.3. {$long}</h2>"), lintNode('200', "<h2>{$long}</h2>")]);
    expect(array_column($r['findings'], 'startLine'))->toBe(['200']);
});

it('counts copies of one text once when deciding what is page chrome (8d829795 / 161d0385)', function () {
    $lint = new ConversionLint;
    $sentences = [];
    foreach (range(1, 6) as $n) {
        $sentences[] = "Academic labour is a specific historical form of academic work, sentence {$n}.";
    }
    $copy = array_fill_keys($sentences, 1);
    $leaks = $lint->chromeLeaksFromCounts([
        'lane_a' => $copy + ['tripleC 16(1): 1-20' => 1],
        'lane_b' => $copy + ['tripleC 16(1): 1-20' => 1],
        'lane_c' => $copy,
        'other_1' => ['tripleC 16(1): 1-20' => 1],
        'other_2' => ['tripleC 16(1): 1-20' => 1],
    ]);
    expect($leaks['lane_a'] ?? [])->toBe(['tripleC 16(1): 1-20'])
        ->and($leaks['lane_c'] ?? [])->toBe([]);
});

it('does not call a quotation that completes its lead-in sentence a fragment when the PDF indents it (bd7c450b)', function () {
    $nodes = [
        lintNode('100', '<p>This has also shaped the conception of society. Society, in this sense, is defined as a</p>'),
        lintNode('200', '<blockquote>specific, historically concrete system of societal relations that is shaped by principles and that humans enter.</blockquote>'),
    ];
    expect(detectors((new ConversionLint)->lintBook($nodes)))->toBe(['fragment_blockquote']);
    $evidence = ['quote_blocks' => ['specifichistoricallyconcretesystemofsocietalrelationsthatisshap']];
    expect(detectors((new ConversionLint)->lintBook($nodes, null, $evidence)))->toBe([]);
});

it('does not flag a colon heading the PDF sets in a heading type style (db2d8fb7)', function () {
    $nodes = [
        lintNode('100', '<h2>Beauty as a principle of society:</h2>'),
        lintNode('200', '<p>What we can learn from Morris is the importance of beauty.</p>'),
        lintNode('300', '<h2>Available functions:</h2>'),
    ];
    $r = (new ConversionLint)->lintBook($nodes, null, ['heading_lines' => ['beautyasaprincipleofsociety']]);
    expect(array_column($r['findings'], 'startLine'))->toBe(['300']);
});

it('does not call a cited block quotation a fragment when no indentation record covers it (90556e72)', function () {
    $leadInNamesSource = [
        lintNode('100', '<p>Roger Griffin takes an approach on Trump that is comparable to the one by Paxton. Griffin (1993, 44) defines fascism as</p>'),
        lintNode('200', '<blockquote>a genus of political ideology whose mythic core in its various permutations is a palingenetic form of populist ultra-nationalism.</blockquote>'),
    ];
    $blockClosesOnSource = [
        lintNode('100', '<p>He ranks them among the inferior classes" (2000, 29-30). Furthermore, the word people signals</p>'),
        lintNode('200', '<blockquote>a dialectical oscillation between on the one hand, the People as a whole and as an integral body politic, and on the other the subset of the excluded (Agamben 2000, 31).</blockquote>'),
    ];
    $bareFragment = [
        lintNode('100', '<p>Alternative voices are less heard or read on the Internet than Mainstream ones. The assignment of</p>'),
        lintNode('200', '<blockquote>domain names (such as microsoft.com) has been commodified, which favours large corporate actors.</blockquote>'),
    ];

    expect(detectors((new ConversionLint)->lintBook($leadInNamesSource)))->toBe([]);
    expect(detectors((new ConversionLint)->lintBook($blockClosesOnSource)))->toBe([]);
    expect(detectors((new ConversionLint)->lintBook($bareFragment)))->toBe(['fragment_blockquote']);
});

it('does not flag a long heading that is one of a series (2b51bc20)', function () {
    $long = str_repeat('The circumstance that the award exists brings up the question of what critical studies are about. ', 2);
    $nodes = [lintNode('100', '<h1>Critical Media and Communication Studies Today</h1>')];
    foreach ([1, 2, 3, 4] as $n) {
        $nodes[] = lintNode((string) (100 + $n * 100), '<h2>Discussion Turn '.$n.' (Christian Fuchs): "'.($n === 2 ? $long : 'Short.').'"</h2>');
        $nodes[] = lintNode((string) (150 + $n * 100), '<p>Body text of the turn follows here in full sentences.</p>');
    }
    expect(detectors((new ConversionLint)->lintBook($nodes)))->toBe([]);

    $alone = [
        lintNode('100', '<h1>Title</h1>'),
        lintNode('200', '<h2>'.$long.'</h2>'),
        lintNode('300', '<p>Body text follows here in full sentences.</p>'),
    ];
    expect(detectors((new ConversionLint)->lintBook($alone)))->toBe(['long_heading']);
});
