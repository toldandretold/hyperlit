<?php

/**
 * HtmlBlockSplitter — lifts block elements out of paragraphs so each becomes its
 * own renderable node. Regression guard for the "AI answer cut off at the first
 * blockquote" bug: an LLM `<p>…<blockquote>…</blockquote>…</p>` must not collapse
 * into a single node whose tail vanishes on render.
 */

use App\Services\AiBrain\HtmlBlockSplitter;

test('lifts a blockquote out of a paragraph into three blocks', function () {
    $html = '<p>He writes that <blockquote>the quote</blockquote> So on one side, orthodoxy threatens education.</p>';

    $blocks = HtmlBlockSplitter::split($html);

    expect($blocks)->toHaveCount(3);
    expect($blocks[0])->toContain('He writes that');
    expect($blocks[0])->not->toContain('blockquote');
    expect($blocks[1])->toContain('<blockquote>the quote</blockquote>');
    expect($blocks[2])->toContain('So on one side');
    // No block-in-paragraph nesting survives.
    foreach ($blocks as $b) {
        expect(preg_match('/<p[^>]*>.*<blockquote/is', $b))->toBe(0);
    }
});

test('keeps inline elements (em, a) grouped with their surrounding text', function () {
    $html = '<p>the tradition of <em>ijtihad</em> <blockquote>q</blockquote> the <em>Einfühlung</em> he names.</p>';

    $blocks = HtmlBlockSplitter::split($html);

    expect($blocks)->toHaveCount(3);
    expect($blocks[0])->toContain('<em>ijtihad</em>');
    // Trailing inline run stays a single paragraph, not split per inline node.
    expect($blocks[2])->toContain('<em>Einfühlung</em>');
    expect($blocks[2])->toContain('he names');
});

test('leaves ordinary paragraphs untouched', function () {
    $blocks = HtmlBlockSplitter::split('<p>one</p><p>two</p>');
    expect($blocks)->toHaveCount(2);
    expect($blocks[0])->toContain('one');
    expect($blocks[1])->toContain('two');
});

test('preserves an inline hypercite anchor inside a paragraph', function () {
    $html = '<p>As Smith argues <a id="hypercite_abc" href="/book_x#hypercite_abc"><sup class="open-icon">&nearr;</sup></a> here.</p>';

    $blocks = HtmlBlockSplitter::split($html);

    expect($blocks)->toHaveCount(1);
    expect($blocks[0])->toContain('id="hypercite_abc"');
    expect($blocks[0])->toContain('href="/book_x#hypercite_abc"');
    expect($blocks[0])->toContain('open-icon');
});

test('returns an empty array for empty input', function () {
    expect(HtmlBlockSplitter::split(''))->toBe([]);
    expect(HtmlBlockSplitter::split('   '))->toBe([]);
});
