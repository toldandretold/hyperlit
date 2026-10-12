<?php

/**
 * FixBareExtLinkHrefs::repairHtml — the sweep that repairs stored node HTML
 * carrying the pre-fix JATS converter's bare-identifier anchors (relative
 * hrefs that Googlebot resolved against hyperlit.io, GSC 2026-10).
 *
 * Pass A deletes empty relative anchors (self-closed <ext-link/> output);
 * pass B absolutizes classifiable identifiers (mirrors
 * JatsFullText::absoluteExtLinkUrl); pass C unwraps JATS-junk anchors (bare
 * numbers, scholar query strings, pct-encoded citation text) keeping their
 * text. Everything already-correct — and the ../page.html web-scrape relics
 * this sweep deliberately does not own — is byte-identical on the way out.
 */

use App\Console\Commands\FixBareExtLinkHrefs;

test('absolutizes bare DOI hrefs in stored HTML', function () {
    [$html, $stats] = FixBareExtLinkHrefs::repairHtml(
        '<p>see <a href="10.1371/journal.pone.0144717">this study</a> for details</p>'
    );
    expect($html)->toBe('<p>see <a href="https://doi.org/10.1371/journal.pone.0144717">this study</a> for details</p>');
    expect($stats)->toBe(['removed' => 0, 'rewritten' => 1, 'unlinked' => 0]);
});

test('absolutizes PMC-prefixed and www hrefs', function () {
    [$html] = FixBareExtLinkHrefs::repairHtml(
        '<a href="PMC4702792">pmc</a> and <a href="www.example.org/x">site</a>'
    );
    expect($html)->toBe(
        '<a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC4702792/">pmc</a> and <a href="https://www.example.org/x">site</a>'
    );
});

test('deletes empty relative anchors — the self-closed ext-link output', function () {
    [$html, $stats] = FixBareExtLinkHrefs::repairHtml(
        'Godlee F, Jefferson T. Peer Review in Health Sciences; 2003.'
        . '<a href="title=Peer%20Review%20in%20Health%20Sciences&amp;author=F%20Godlee&amp;"></a>'
        . '<a href="10.1186/1741-7015-8-62"></a><a href="PMC2974654"></a><a href="20961441"></a>Next ref.'
    );
    expect($html)->toBe('Godlee F, Jefferson T. Peer Review in Health Sciences; 2003.Next ref.');
    expect($stats)->toBe(['removed' => 4, 'rewritten' => 0, 'unlinked' => 0]);
});

test('unwraps bare-number anchors with text (pmid vs pmcid unknowable), keeping the text', function () {
    [$html, $stats] = FixBareExtLinkHrefs::repairHtml(
        '<p>ref <a href="25448298">Smith 2014</a> end</p>'
    );
    expect($html)->toBe('<p>ref Smith 2014 end</p>');
    expect($stats)->toBe(['removed' => 0, 'rewritten' => 0, 'unlinked' => 1]);
});

test('unwraps query-string and pct-encoded anchors with text, keeping the text', function () {
    [$html, $stats] = FixBareExtLinkHrefs::repairHtml(
        '<a href="journal=BMC%20Med&amp;title=Surveys&amp;">Google Scholar</a>'
        . ' <a href="Lock%20S.%20A%20difficult%20balance">Lock</a>'
    );
    expect($html)->toBe('Google Scholar Lock');
    expect($stats['unlinked'])->toBe(2);
});

test('leaves absolute, fragment, root-relative and mailto hrefs byte-identical', function () {
    $input = '<a href="https://doi.org/10.1/x">a</a>'
        . '<a class="in-text-citation" href="#bib3">b</a>'
        . '<a href="/marx1992capital1">c</a>'
        . '<a href="mailto:x@y.z">d</a>'
        . '<a href="https://example.org/search?q=marx&amp;page=2">query-string absolute</a>';
    [$html, $stats] = FixBareExtLinkHrefs::repairHtml($input);
    expect($html)->toBe($input);
    expect($stats)->toBe(['removed' => 0, 'rewritten' => 0, 'unlinked' => 0]);
});

test('leaves scheme-carrying non-http hrefs (whatsapp share links, tel:) byte-identical', function () {
    $input = '<a href="whatsapp://send?text=https%3A%2F%2Faje.io%2Fa45fd">share</a>'
        . '<a href="tel:+61400000000">call</a>';
    [$html, $stats] = FixBareExtLinkHrefs::repairHtml($input);
    expect($html)->toBe($input);
    expect($stats)->toBe(['removed' => 0, 'rewritten' => 0, 'unlinked' => 0]);
});

test('leaves web-scrape relative relics alone rather than guessing', function () {
    $input = '<a href="../../contents.html">contents</a><a href="some/page.html">x</a>';
    [$html, $stats] = FixBareExtLinkHrefs::repairHtml($input);
    expect($html)->toBe($input);
    expect($stats)->toBe(['removed' => 0, 'rewritten' => 0, 'unlinked' => 0]);
});

test('handles HTML-entity-encoded href values (converter htmlspecialchars pass)', function () {
    [$html, $stats] = FixBareExtLinkHrefs::repairHtml(
        '<a href="10.1000/a&amp;b">entity doi</a>'
    );
    expect($html)->toBe('<a href="https://doi.org/10.1000/a&amp;b">entity doi</a>');
    expect($stats['rewritten'])->toBe(1);
});
