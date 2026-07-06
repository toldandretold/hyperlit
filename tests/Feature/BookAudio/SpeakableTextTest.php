<?php

use App\Services\Tts\SpeakableText;

/**
 * SpeakableText: content HTML → narration text. These transformations feed
 * source_hash — a rule change here flips generated books stale (deliberate,
 * never incidental). Markup shapes below are the REAL stored forms captured
 * from the DB + write paths (see docs/audio.md).
 */

it('speaks a bracketed numeric citation as "citation N"', function () {
    $html = '<p id="2600">Beat Saber [<a class="in-text-citation" href="#bib.bib9" title="">9</a>] is an award-winning game.</p>';
    expect(SpeakableText::fromContent($html))
        ->toBe('Beat Saber (citation 9) is an award-winning game.');
});

it('keeps a textual citation as natural text', function () {
    $html = '<p>As shown <a class="in-text-citation" href="#bib.bib3">(Smith, 2020)</a> this holds.</p>';
    expect(SpeakableText::fromContent($html))
        ->toBe('As shown (Smith, 2020) this holds.');
});

it('reads author-year citations as written — no "citation" injected before a bare year', function () {
    // Real shape: names are sibling text, the anchor wraps only the year.
    $html = '<p>Gender gaps persist (e.g., Dolan and Lawless, <a class="in-text-citation" href="#bib1">2024</a>; Tripp and Dion, <a class="in-text-citation" href="#bib2">2024</a>).</p>';
    expect(SpeakableText::fromContent($html))
        ->toBe('Gender gaps persist (e.g., Dolan and Lawless, 2024; Tripp and Dion, 2024).');
});

it('unwraps the editor citation-ref (Author Year) shape', function () {
    $html = '<p>Seen before (Author <a id="Ref123_ab" class="citation-ref">1999</a>).</p>';
    expect(SpeakableText::fromContent($html))
        ->toBe('Seen before (Author 1999).');
});

it('speaks footnote markers as "footnote N" in all three shapes', function () {
    $canonical = '<p>Really? Shit dawg.<sup fn-count-id="1" id="Fn1_x" class="footnote-ref">1</sup></p>';
    expect(SpeakableText::fromContent($canonical))->toBe('Really? Shit dawg. (footnote 1)');

    $withAnchor = '<p>What.<sup fn-count-id="2" id="book_Fn2"><a class="footnote-ref" href="#book_Fn2">2</a></sup></p>';
    expect(SpeakableText::fromContent($withAnchor))->toBe('What. (footnote 2)');

    $old = '<p>Hm.<sup fn-count-id="3" id="Fnref3"><a href="#Fn3">3</a></sup></p>';
    expect(SpeakableText::fromContent($old))->toBe('Hm. (footnote 3)');
});

it('speaks the hypercite arrow as "hypercite link" in all three shapes', function () {
    // U+2060 word-joiner before the anchor, exactly as the editor writes it.
    $new = "<p>'quoted text'\u{2060}<a href=\"#hypercite_a\" id=\"hypercite_b\" class=\"open-icon\">\u{2197}</a></p>";
    expect(SpeakableText::fromContent($new))->toBe("'quoted text' (hypercite link)");

    $old = "<p>'quoted'\u{2060}<a href=\"#hypercite_a\" id=\"hypercite_b\"><sup class=\"open-icon\">\u{2197}</sup></a></p>";
    expect(SpeakableText::fromContent($old))->toBe("'quoted' (hypercite link)");

    $flipped = '<p>text<sup class="open-icon"><a href="#hypercite_x">&#8599;</a></sup></p>';
    expect(SpeakableText::fromContent($flipped))->toBe('text (hypercite link)');
});

it('never lets the &nearr; entity or arrow glyph reach the narration', function () {
    // AI-archivist hypercites store the literal entity (AiBrainController).
    $html = '<p>quote<a id="hypercite_q" href="#h"><sup class="open-icon">&nearr;</sup></a> more</p>';
    $out = SpeakableText::fromContent($html);
    expect($out)->not->toContain('nearr');
    expect($out)->not->toContain("\u{2197}");
    expect($out)->toBe('quote (hypercite link) more');
});

it('unwraps highlights and hypercite underlines, keeping their text', function () {
    $html = '<p><mark class="HL_1 hl-confirmed">Classes are 3 hour seminars</mark> and <u class="couple">cited text</u>.</p>';
    expect(SpeakableText::fromContent($html))
        ->toBe('Classes are 3 hour seminars and cited text.');
});

it('decodes entities and strips invisible characters', function () {
    $html = "<p>Heads &amp; hands\u{200B} move&nbsp;fast.</p>";
    expect(SpeakableText::fromContent($html))->toBe('Heads & hands move fast.');
});

it('speaks math placeholders and drops images and page numbers', function () {
    $html = '<p>Given <latex data-math="E=mc^2"></latex> we see <img src="/x.png" alt="figure"> results<span class="pageNumber">42</span>.</p>';
    expect(SpeakableText::fromContent($html))->toBe('Given equation we see results.');
});

it('keeps block and <br> boundaries as word gaps', function () {
    $html = '<p>Line one<br>line two</p><p>Next para</p>';
    expect(SpeakableText::fromContent($html))->toBe('Line one line two Next para');
});

it('treats decoration-only or empty content as unspeakable', function () {
    expect(SpeakableText::isSpeakable('<p><br></p>'))->toBeFalse();
    expect(SpeakableText::isSpeakable('<p><img src="/x.png"></p>'))->toBeFalse();
    expect(SpeakableText::isSpeakable(null))->toBeFalse();
    expect(SpeakableText::isSpeakable('<p>Words.</p>'))->toBeTrue();
});
