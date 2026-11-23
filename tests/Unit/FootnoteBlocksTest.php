<?php

/**
 * FootnoteBlocks — an imported footnote's HTML → one sub-book node per block.
 *
 * Imports used to flatten every footnote into a single <p> (strip_tags), so a
 * multi-paragraph footnote with a quotation was stored as one run of text,
 * welded at the joins. The conversion hands content over as paragraphs joined
 * by <br><br> with whole block elements between them; these pin the split.
 */

use App\Services\DocumentImport\FootnoteBlocks;

function fnbShape(string $content): array
{
    return array_map(
        fn (array $n) => preg_replace('/ (data-node-id|style)="[^"]*"/', '', $n['content']),
        FootnoteBlocks::nodes($content)
    );
}

test('paragraphs, a quotation and a list each become their own node, in order', function () {
    $content = 'As one account has it:<br/><br/><blockquote><p>the commons is about <em>groups</em></p><p>and their work</p></blockquote>'
        . '<br><br>Three reasons:<br><br><ul><li>first</li><li>second <a href="https://x.test">link</a></li></ul><br><br>So it goes.';

    expect(fnbShape($content))->toBe([
        '<p>As one account has it:</p>',
        '<blockquote>the commons is about <em>groups</em></blockquote>',
        '<blockquote>and their work</blockquote>',
        '<p>Three reasons:</p>',
        '<ul><li>first</li><li>second <a href="https://x.test">link</a></li></ul>',
        '<p>So it goes.</p>',
    ]);

    $nodes = FootnoteBlocks::nodes($content);
    expect(array_column($nodes, 'startLine'))->toBe([1, 2, 3, 4, 5, 6]);
    expect($nodes[4]['plainText'])->toBe('first second link');
    expect(count(array_unique(array_column($nodes, 'node_id'))))->toBe(6);
});

test('a one-paragraph footnote is one node, a single break is a space, and only inline markup survives', function () {
    expect(fnbShape('Smith, <i>Title</i>,<br>London &amp; <span class="x">New York</span> <script>x()</script>1999.'))
        ->toBe(['<p>Smith, <i>Title</i>, London &amp; New York x()1999.</p>']);
});

test('a table is kept as its words, never welded, and an empty footnote is still one empty paragraph', function () {
    expect(fnbShape('See:<br><br><table><tr><td>a</td><td>b</td></tr></table>'))->toBe(['<p>See:</p>', '<p>a b</p>']);
    expect(fnbShape(''))->toBe(['<p></p>']);
});

test('the definition anchor rides the first paragraph instead of becoming an empty node above it', function () {
    // The EPUB lane's shape: the anchor is an inline run of its own BEFORE the first <p>. As a
    // node of its own, every such footnote opened on a blank line (Capital via marxists.org).
    $anchor = '<a fn-count-id="2" id="Fn1795425561249_00m5"></a>';

    expect(fnbShape($anchor . '<p><cite>Geschichtliche Darstellung</cite>, von Gülich.</p><p>Second paragraph.</p>'))->toBe([
        '<p>' . $anchor . 'Geschichtliche Darstellung, von Gülich.</p>',
        '<p>Second paragraph.</p>',
    ]);

    // Same when the note opens with a quotation.
    expect(fnbShape($anchor . '<blockquote><p>Quoted.</p></blockquote>'))->toBe([
        '<blockquote>' . $anchor . 'Quoted.</blockquote>',
    ]);

    // The <br><br> shape never had the problem and is unchanged.
    expect(fnbShape($anchor . 'One.<br><br>Two.'))->toBe(['<p>' . $anchor . 'One.</p>', '<p>Two.</p>']);

    // An EMPTY footnote keeps its anchor paragraph: still a place to type.
    expect(fnbShape($anchor))->toBe(['<p>' . $anchor . '</p>']);

    // And an empty paragraph that is NOT first-of-a-pair with text (a list follows) is left alone.
    expect(fnbShape($anchor . '<ul><li>item</li></ul>'))->toBe(['<p>' . $anchor . '</p>', '<ul><li>item</li></ul>']);
});
