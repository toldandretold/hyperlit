<?php

use App\Services\Annotations\AnchorAmbiguousException;
use App\Services\Annotations\AnchorNotFoundException;
use App\Services\Annotations\AnnotationAnchorService;

/**
 * The MCP quote → charData locator. The coordinate space is the CLIENT's:
 * DOM textContent (tags stripped, entities DECODED), offsets in UTF-16 code
 * units. These tests pin exactly the traps called out in the service: the
 * plainText-vs-plainOf gap, astral-char counting, latex exclusion, node
 * spans, whitespace tolerance and occurrence disambiguation.
 */

function anchorNodes(): array
{
    return [
        ['node_id' => 'n1', 'startLine' => '100', 'content' => '<h1 id="100">The Mirror &amp; the Lamp</h1>'],
        ['node_id' => 'n2', 'startLine' => '200', 'content' => '<p id="200">Romantic theory treats art as expression. It recurs.</p>'],
        ['node_id' => 'n3', 'startLine' => '300', 'content' => '<p id="300">It recurs, indeed.</p>'],
    ];
}

test('entities are decoded before offsets are measured', function () {
    $anchor = AnnotationAnchorService::locate(anchorNodes(), 'Mirror & the');

    expect($anchor['node_ids'])->toBe(['n1']);
    // "The Mirror & the Lamp": "Mirror" starts at 4 in DECODED text.
    expect($anchor['charData']['n1'])->toBe(['charStart' => 4, 'charEnd' => 16]);
    expect($anchor['startLine'])->toBe('100');
    expect($anchor['highlightedText'])->toBe('Mirror & the');
});

test('a quote spanning two nodes anchors both, end-of-first to start-of-second', function () {
    $anchor = AnnotationAnchorService::locate(anchorNodes(), "the Lamp\nRomantic theory");

    expect($anchor['node_ids'])->toBe(['n1', 'n2']);
    $n1Plain = 'The Mirror & the Lamp';
    expect($anchor['charData']['n1'])->toBe(['charStart' => 13, 'charEnd' => mb_strlen($n1Plain)]);
    expect($anchor['charData']['n2'])->toBe(['charStart' => 0, 'charEnd' => mb_strlen('Romantic theory')]);
});

test('whitespace differences between quote and text are tolerated', function () {
    $anchor = AnnotationAnchorService::locate(anchorNodes(), "Romantic   theory\ntreats art");

    expect($anchor['node_ids'])->toBe(['n2']);
    expect($anchor['charData']['n2']['charStart'])->toBe(0);
});

test('an ambiguous quote throws with one context per match, and occurrence selects', function () {
    try {
        AnnotationAnchorService::locate(anchorNodes(), 'It recurs');
        $this->fail('expected AnchorAmbiguousException');
    } catch (AnchorAmbiguousException $e) {
        expect($e->contexts)->toHaveCount(2);
        expect($e->contexts[1])->toContain('[It recurs]');
    }

    $second = AnnotationAnchorService::locate(anchorNodes(), 'It recurs', 2);
    expect($second['node_ids'])->toBe(['n3']);
    expect($second['charData']['n3'])->toBe(['charStart' => 0, 'charEnd' => 9]);
});

test('a missing quote and an out-of-range occurrence throw not-found', function () {
    expect(fn () => AnnotationAnchorService::locate(anchorNodes(), 'not in the book'))
        ->toThrow(AnchorNotFoundException::class);
    expect(fn () => AnnotationAnchorService::locate(anchorNodes(), 'Romantic theory', 2))
        ->toThrow(AnchorNotFoundException::class);
});

test('latex nodes are unanchorable', function () {
    $nodes = [
        ['node_id' => 'n1', 'startLine' => '100', 'content' => '<p><latex data-math="E=mc^2">E=mc^2</latex></p>'],
        ['node_id' => 'n2', 'startLine' => '200', 'content' => '<p>Plain prose.</p>'],
    ];

    expect(fn () => AnnotationAnchorService::locate($nodes, 'E=mc^2'))
        ->toThrow(AnchorNotFoundException::class);

    // The neighbour is still anchorable, at its own offsets.
    $anchor = AnnotationAnchorService::locate($nodes, 'Plain prose');
    expect($anchor['charData']['n2']['charStart'])->toBe(0);
});

test('offsets are UTF-16 code units: astral chars count double', function () {
    $nodes = [
        ['node_id' => 'n1', 'startLine' => '100', 'content' => '<p>🔥🔥 burning words</p>'],
    ];

    $anchor = AnnotationAnchorService::locate($nodes, 'burning');

    // JS: "🔥🔥 ".length === 5 (2+2+1); mb codepoints would say 3.
    expect($anchor['charData']['n1'])->toBe(['charStart' => 5, 'charEnd' => 12]);
});

test('plainOf matches the client coordinate space, not stored plainText', function () {
    expect(AnnotationAnchorService::plainOf('<p>a &amp; b&nbsp;c</p>'))
        ->toBe('a & b'."\u{00A0}".'c');
    expect(AnnotationAnchorService::plainOf(null))->toBe('');
});
