<?php

/**
 * The text transforms behind `library:repair-abstract-in-note` — the repair for
 * abstracts that a pasted OJS BibTeX entry filed as citation notes (see the
 * command's docblock, and tests/javascript/utilities/bibtexAutofill.test.js for
 * the parsing bug that put them there).
 *
 * Pure helpers on purpose: the command's own write path touches `library` on
 * pgsql_admin, which a RefreshDatabase Feature test cannot exercise without the
 * cross-connection deadlock (see CLAUDE.md).
 */

use App\Console\Commands\RepairAbstractInNoteCommand as Repair;

test('an OJS double-escaped abstract decodes to plain prose', function () {
    // Exactly the shape from the real export in tests/fixtures/bibtex/.
    $raw = '&amp;lt;p&amp;gt;This article argues that the political effects of '
        . 'digitalization in peripheral societies emerge.&amp;lt;/p&amp;gt;';

    $clean = Repair::cleanAbstract($raw);

    expect($clean)->toBe('This article argues that the political effects of digitalization in peripheral societies emerge.');
    expect($clean)->not->toContain('&');
    expect($clean)->not->toContain('lt;');
});

test('a singly-escaped abstract decodes too, and real markup is stripped', function () {
    expect(Repair::cleanAbstract('&lt;p&gt;One.&lt;/p&gt;'))->toBe('One.');
    expect(Repair::cleanAbstract('<p>One.</p>'))->toBe('One.');
});

test('paragraph breaks survive as blank lines rather than joined words', function () {
    $clean = Repair::cleanAbstract('&amp;lt;p&amp;gt;First para.&amp;lt;/p&amp;gt;&amp;lt;p&amp;gt;Second para.&amp;lt;/p&amp;gt;');

    expect($clean)->toBe("First para.\n\nSecond para.");
});

test('an entity-bearing abstract keeps its real punctuation', function () {
    expect(Repair::cleanAbstract('&amp;lt;p&amp;gt;Marx &amp;amp;amp; Engels on &amp;quot;value&amp;quot;.&amp;lt;/p&amp;gt;'))
        ->toBe('Marx & Engels on "value".');
});

test('a bibtex note field is recognised only when it holds that same text', function () {
    $bib = "@article{x,\n  title = {T},\n  note = {An abstract paragraph.},\n  year = {2026}\n}";

    expect(Repair::bibtexNoteMatches($bib, 'An abstract paragraph.'))->toBeTrue();
    expect(Repair::bibtexNoteMatches($bib, 'Something else'))->toBeFalse();
});

test('abstractNote is not mistaken for note — the bug this repairs, in reverse', function () {
    $bib = "@article{x,\n  title = {T},\n  abstractNote = {An abstract paragraph.}\n}";

    expect(Repair::bibtexNoteMatches($bib, 'An abstract paragraph.'))->toBeFalse();
    expect(Repair::removeBibtexField($bib, 'note'))->toBe($bib);
});

test('removing the note field leaves valid, note-free bibtex', function () {
    $bib = "@article{x,\n  title = {T},\n  note = {An abstract paragraph.},\n  year = {2026}\n}";
    $out = Repair::removeBibtexField($bib, 'note');

    expect($out)->not->toContain('note');
    expect($out)->toContain('title = {T}');
    expect($out)->toContain('year = {2026}');
    // Still parses as the same entry, minus the note.
    $cards = new \App\Services\LibraryCardGenerator();
    expect($cards->parseBibtexToHtml($out))->not->toContain('abstract paragraph');
    expect($cards->parseBibtexToHtml($out))->toContain('2026');
});

test('a trailing note field does not leave a dangling comma', function () {
    $bib = "@article{x,\n  title = {T},\n  note = {Gone}\n}";
    $out = Repair::removeBibtexField($bib, 'note');

    expect($out)->not->toContain('Gone');
    expect(preg_match('/,\s*\}/', $out))->toBe(0);
});
