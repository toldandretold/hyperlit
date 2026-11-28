<?php

use App\Services\Marxists\MarxistsCitation;
use App\Services\Marxists\MarxistsWorkClassifier as C;

/**
 * Book, article or letter — read from the work's own page. Every information block below is
 * copied from the real page named beside it.
 */

const MIA = 'https://www.marxists.org/archive/';

it('reads a newspaper piece as an article and names the paper the page names', function (string $path, string $title, array $info, string $journal) {
    $r = C::classify(MIA . $path, $title, $info, 1);
    expect($r['genre'])->toBe('article');
    expect($r['type'])->toBe('article');
    expect($r['journal'])->toBe($journal);
})->with([
    'the british rule in india' => ['marx/works/1853/06/25.htm', 'The British Rule in India',
        ['Written' => 'June 10, 1853', 'First published' => 'in the New-York Daily Tribune, June 25, 1853'], 'New-York Daily Tribune'],
    'on the thefts of wood' => ['marx/works/1842/10/25.htm', 'Proceedings of the Sixth Rhine Province Assembly.: Third Article.',
        ['Written' => 'October 1842 [88]', 'First published' => 'in the Supplement to the Rheinische Zeitung, Nos. 298, 300, 303, 305 and 307, October 25, 27 and 30, November 1 and 3, 1842'], 'Rheinische Zeitung'],
    'letters from wuppertal (an article, despite its title)' => ['marx/works/1839/03/telegraph.htm', 'Letters from Wuppertal',
        ['Written' => 'in March 1839', 'First published' => 'in the Telegraph für Deutschland Nos. 49, 50, 51 and 52 for March and Nos. 57 and 59 for April, 1839.'], 'Telegraph für Deutschland'],
    'on the jewish question (the issue date first)' => ['marx/works/1844/jewish-question/index.htm', 'On The Jewish Question',
        ['Written' => 'Autumn 1843', 'First Published' => 'February, 1844 in Deutsch-Französische Jahrbücher'], 'Deutsch-Französische Jahrbücher'],
    'the part played by labour (the volume year after the name)' => ['marx/works/1876/part-played-labour/index.htm', 'The Part played by Labour in the Transition from Ape to Man',
        ['Written' => 'in May-June 1876', 'First published' => 'in Die Neue Zeit 1895-06', 'First published in English' => 'by Progress Publishers, Moscow, 1934'], 'Die Neue Zeit'],
    'the bedouin' => ['marx/works/1838/09/16.htm', 'The Bedouin',
        ['First published' => 'in the Bremisches Conversationsblatt No. 40, Sept. 16, 1838', 'Source' => 'MECW Volume 2'], 'Bremisches Conversationsblatt'],
]);

it('reads a private letter as a letter, dated by when it was written and never by when it was first printed', function () {
    $r = C::classify(MIA . 'marx/works/1867/letters/67_12_14.htm', 'Marx To Engels: In Manchester', [
        'Source' => 'MECW Volume 42, p. 501',
        'First published' => 'abridged in Der Briefwechsel zwischen F. Engels und K. Marx, Stuttgart, 1913 and in full in MEGA, Berlin, 1930.',
    ], 1);
    expect($r)->toMatchArray(['genre' => 'letter', 'type' => 'misc', 'journal' => null, 'year' => 1867]);

    // With a "Written" line the page has already dated it; nothing to correct.
    $r = C::classify(MIA . 'marx/works/1867/letters/67_12_14.htm', 'Marx To Engels', ['Written' => '14 December 1867'], 1);
    expect($r['year'])->toBeNull();
});

it('knows a Lenin letter by the Collected Works volume its page cites — MIA files it by date like any other text', function () {
    $r = C::classify(MIA . 'lenin/works/1893/oct/00mu.htm', 'To His Sister Maria', [
        'Written' => 'October 1893', 'Source' => 'Lenin Collected Works, Progress Publishers, 1977, Moscow, Volume 37, pages 65-66',
    ], 1);
    expect($r['genre'])->toBe('letter');

    // "To the Rural Poor" opens the same way and is a pamphlet in volume 6.
    $r = C::classify(MIA . 'lenin/works/1903/rp/index.htm', 'To the Rural Poor', [
        'Written' => 'March 1903', 'Source' => 'Lenin Collected Works, Foreign Languages Publishing House, 1961, Moscow, Volume 6, pages 361-432',
    ], 1);
    expect($r['genre'])->toBe('short_work');
});

it('calls anything stitched from several pages a book, whatever it is a book of', function () {
    expect(C::classify(MIA . 'marx/works/1867/letters/index.htm', 'Letters of Marx and Engels: 1867', [], 51)['genre'])->toBe('book');
    // Serialised in a newspaper, read as a pamphlet: still a book, and no periodical claimed.
    $r = C::classify(MIA . 'marx/works/1847/wage-labour/index.htm', 'Wage Labour and Capital',
        ['First Published (in German)' => 'Neue Rheinische Zeitung, April 5-8 and 11, 1849'], 9);
    expect($r)->toMatchArray(['genre' => 'book', 'type' => 'book', 'journal' => null]);
});

it('names no periodical the page does not name beside an issue', function (string $firstPublished) {
    expect(C::periodical(['First Published' => $firstPublished]))->toBeNull();
})->with([
    'a language' => ['in German in 1867'],
    'a book' => ['abridged in Der Briefwechsel zwischen F. Engels und K. Marx, Stuttgart, 1913'],
    'an appendix' => ['As an appendix to Ludwig Feuerbach and the End of Classical German Philosophy in 1888'],
    'a bare year' => ['1913.'],
    'issues, in prose' => ['March, April, and May issues of Revue Socialiste in 1880'],
]);

it('files a single page that names no periodical as a short work, not as a book', function () {
    $r = C::classify(MIA . 'marx/works/1845/theses/theses.htm', 'Theses On Feuerbach', [
        'Written' => 'by Marx in the Spring of 1845', 'First Published' => 'As an appendix to Ludwig Feuerbach and the End of Classical German Philosophy in 1888',
    ], 1);
    expect($r)->toMatchArray(['genre' => 'short_work', 'type' => 'misc', 'journal' => null]);
});

it('tidies the stored information block: no doubled colons, no footnote read as a field', function () {
    expect(MarxistsCitation::cleanNote('Written: : June 10, 1853 | First published: : in the New-York Daily Tribune | 4: A reference to the rule in India, mainly in the north'))
        ->toBe('Written: June 10, 1853 | First published: in the New-York Daily Tribune');
    $clean = 'Written: December 1851 - March 1852 | Source: Chapters 1 & 7: translated by Saul K. Padover';
    expect(MarxistsCitation::cleanNote($clean))->toBe($clean);
});
