<?php

/**
 * BookMarkdownExporter — the server-side port of the source panel's
 * buildMarkdownForBook. Locks the hyperlit-construct conversions:
 *   - sup.footnote-ref → [^n] with the definition from the footnote's
 *     sub-book nodes (falling back to footnotes.preview_nodes / .content);
 *   - hypercite arrows → [^n] with a compact citation of the cited book
 *     linking the hyperlit deep URL;
 *   - a.citation-ref → unwrapped text + a deduped ## References section;
 *   - one SHARED footnote number sequence across both construct types;
 *   - relative img src absolutized.
 */

use App\Services\Export\BookMarkdownExporter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function bmeDb()
{
    return DB::connection('pgsql_admin');
}

function bmeCleanup(): void
{
    bmeDb()->table('nodes')->where('book', 'LIKE', 'bmebook_%')->delete();
    bmeDb()->table('footnotes')->where('book', 'LIKE', 'bmebook_%')->delete();
    bmeDb()->table('bibliography')->where('book', 'LIKE', 'bmebook_%')->delete();
    bmeDb()->table('library')->where('book', 'LIKE', 'bmebook_%')->delete();
}

beforeEach(fn () => bmeCleanup());

function bmeNode(string $book, float $startLine, string $content, float $chunk = 0): void
{
    bmeDb()->table('nodes')->insert([
        'book'       => $book,
        'node_id'    => $book . '_n' . $startLine,
        'chunk_id'   => $chunk,
        'startLine'  => $startLine,
        'content'    => $content,
        'plainText'  => strip_tags($content),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

test('converts footnotes, hypercites and citation refs with one shared sequence', function () {
    $book = 'bmebook_' . Str::random(8);

    bmeNode($book, 100, '<h1>A Study</h1>');
    bmeNode($book, 101, '<p>Claim<sup class="footnote-ref" id="fn1">1</sup> and cite <a class="open-icon" id="hc1" href="/TargetBook_bme#hypercite_x"><sup class="open-icon">↗</sup></a>.</p>');
    bmeNode($book, 102, '<p>See <a class="citation-ref" id="ref1" href="#bib">(Marx 1867)</a> for more.</p>');

    // Footnote body lives in the sub-book.
    bmeNode($book . '/fn1', 100, '<p>The footnote <em>body</em>.</p>');

    bmeDb()->table('library')->insert([
        'book'       => 'TargetBook_bme',
        'title'      => 'Bme Target Title',
        'author'     => 'Target Author',
        'year'       => '1999',
        'creator'    => 'someone',
        'visibility' => 'public',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    bmeDb()->table('bibliography')->insert([
        'book'        => $book,
        'referenceId' => 'ref1',
        'content'     => '<p>Marx, K. <i>Capital</i>. 1867.</p>',
        'created_at'  => now(),
        'updated_at'  => now(),
    ]);

    $md = app(BookMarkdownExporter::class)->markdownFor($book);

    expect($md)->toContain('# A Study')
        ->toContain('Claim[^1]')
        ->toContain('cite [^2]')
        ->toContain('[^1]: The footnote *body*.')
        ->toContain('[^2]: Target Author, “[Bme Target Title](')
        ->toContain('/TargetBook_bme#hypercite_x')
        ->toContain('See (Marx 1867) for more.')
        ->toContain('## References')
        ->toContain('Marx, K. *Capital*. 1867.');

    // The citation-ref must be unwrapped — no link markup around it.
    expect($md)->not->toContain('[(Marx 1867)]');

    // Cleanup the extra library row this test seeded.
    bmeDb()->table('library')->where('book', 'TargetBook_bme')->delete();
});

test('footnote falls back to the footnotes row when no sub-book exists', function () {
    $book = 'bmebook_' . Str::random(8);
    bmeNode($book, 100, '<p>Text<sup class="footnote-ref" id="fn9">9</sup>.</p>');
    bmeDb()->table('footnotes')->insert([
        'book'          => $book,
        'footnoteId'    => 'fn9',
        'content'       => '<p>Row-level footnote text.</p>',
        'preview_nodes' => json_encode([['content' => '<p>Preview footnote text.</p>']]),
        'created_at'    => now(),
        'updated_at'    => now(),
    ]);

    $md = app(BookMarkdownExporter::class)->markdownFor($book);

    expect($md)->toContain('[^1]: Preview footnote text.');
});

test('a hypercite inside a footnote is written inline as a citation linking hyperlit', function () {
    $book = 'bmebook_' . Str::random(8);
    $target = 'bmebook_' . Str::random(8);
    $base = rtrim(config('app.url'), '/');

    bmeNode($book, 100, '<p>Claim<sup class="footnote-ref" id="fn1">1</sup>.</p>');
    bmeNode($book . '/fn1', 100, '<p>As argued elsewhere<a href="/' . $target . '#hypercite_abc" id="hypercite_zzz" class="open-icon">↗</a> and <a href="/u/someone">here</a>.</p>');

    bmeDb()->table('library')->insert([
        'book'       => $target,
        'title'      => 'Bme Cited Title',
        'author'     => 'Cited Author',
        'year'       => '2001',
        'creator'    => 'someone',
        'visibility' => 'public',
        'raw_json'   => '[]',
        'timestamp'  => 0,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $md = app(BookMarkdownExporter::class)->markdownFor($book);

    expect($md)
        ->toContain("[^1]: As argued elsewhere (Cited Author, “[Bme Cited Title]({$base}/{$target}#hypercite_abc)”, 2001) and [here]({$base}/u/someone).")
        // No relative link survives — Obsidian would open a blank note for it.
        ->not->toContain('](/')
        ->not->toContain('↗');
});

test('root-relative links in the body are absolutized, in-page fragments are not', function () {
    $book = 'bmebook_' . Str::random(8);
    bmeNode($book, 100, '<p>See <a href="/some-book">that book</a> and <a href="#sec2">below</a>.</p>');

    $md = app(BookMarkdownExporter::class)->markdownFor($book);

    expect($md)->toContain('[that book](' . rtrim(config('app.url'), '/') . '/some-book)')
        ->toContain('[below](#sec2)');
});

test('relative image sources are absolutized', function () {
    $book = 'bmebook_' . Str::random(8);
    bmeNode($book, 100, '<p><img src="/storage/book-images/x.png" alt="fig"></p>');

    $md = app(BookMarkdownExporter::class)->markdownFor($book);

    expect($md)->toContain('![fig](' . rtrim(config('app.url'), '/') . '/storage/book-images/x.png)');
});

test('obsidianLinks: in-text citations become block links to the bibliography entry', function () {
    $book = 'bmebook_' . Str::random(8);
    bmeNode($book, 100, '<p>Networks are “vast and open” (Harvey <a class="in-text-citation" href="#harvey2020">2020</a>; see <a class="in-text-citation" href="#beck_1992">Beck</a>, and <a class="in-text-citation" href="#missing9">nobody</a>).</p>');
    bmeNode($book, 200, '<h2>References</h2>');
    bmeNode($book, 300, '<p><a class="bib-entry" id="harvey2020"></a>Harvey, David. 2020. Anti-Capitalist Politics.</p>');
    bmeNode($book, 400, '<p><a class="bib-entry" id="beck_1992"></a>Beck, Ulrich. 1992. <i>Risk Society</i>.</p>');

    $md = app(BookMarkdownExporter::class)->markdownFor($book, obsidianLinks: true);

    expect($md)
        ->toContain('(Harvey [2020](#^harvey2020);')
        ->toContain('[Beck](#^beck-1992)')
        // Obsidian needs the block id at the END of the entry's own paragraph.
        ->toMatch('/^Harvey, David\. 2020\. Anti-Capitalist Politics\. \^harvey2020$/m')
        ->toMatch('/^Beck, Ulrich\. 1992\. \*Risk Society\*\. \^beck-1992$/m')
        // A citation with no entry in the document is left alone, never pointed at a block that isn't there.
        ->toContain('[nobody](#missing9)')
        ->not->toContain('@@HLBLOCK');
});

test('obsidianLinks: a pasted article\'s references have no anchor, so they are placed by the bibliography row\'s text', function () {
    // The paste lane writes bare reference paragraphs; `#seaton2016` resolves through the table alone.
    $book = 'bmebook_' . Str::random(8);
    bmeNode($book, 100, '<p>(see also Seaton <a href="#seaton2016" class="in-text-citation">2016</a>; Moore <a href="#moore2017" class="in-text-citation">2017</a>; <a href="#twin2001" class="in-text-citation">2001</a>)</p>');
    bmeNode($book, 200, '<p data-static-content="bibliography"><span>Seaton, J.</span> <span>2016</span> \'<span>Brexit and the Media</span>\', <i>The Political Quarterly</i>  <span>87</span>(<span>3</span>):  <span>333</span>–<span>7</span>.</p>');
    bmeNode($book, 300, '<p data-static-content="bibliography">Twin, A. 2001 The Same Words.</p>');
    bmeNode($book, 400, '<p data-static-content="bibliography">Twin, A. 2001 The Same Words.</p>');
    foreach ([
        'seaton2016' => '<span>Seaton, J.</span> <span>2016</span> \'<span>Brexit and the Media</span>\', <i>The Political Quarterly</i> <span>87</span>(<span>3</span>): <span>333</span>–<span>7</span>.',
        'moore2017'  => 'Moore, M. 2017 A reference whose paragraph is not in the body.',
        'twin2001'   => 'Twin, A. 2001 The Same Words.',
    ] as $refId => $content) {
        bmeDb()->table('bibliography')->insert(['book' => $book, 'referenceId' => $refId, 'content' => $content, 'created_at' => now(), 'updated_at' => now()]);
    }

    $md = app(BookMarkdownExporter::class)->markdownFor($book, obsidianLinks: true);

    expect($md)
        ->toContain('Seaton [2016](#^seaton2016)')
        ->toMatch('/^Seaton, J\. 2016 \'Brexit and the Media\', \*The Political Quarterly\* 87\(3\): 333–7\. \^seaton2016$/m')
        // No paragraph carries it, or two do: left alone rather than pointed at a guess.
        ->toContain('[2017](#moore2017)')
        ->toContain('[2001](#twin2001)')
        ->not->toContain('^twin2001')
        ->not->toContain('@@HLBLOCK');
});

test('without obsidianLinks the export carries no block ids (MCP export, study re-import)', function () {
    $book = 'bmebook_' . Str::random(8);
    bmeNode($book, 100, '<p>(Harvey <a class="in-text-citation" href="#harvey2020">2020</a>)</p>');
    bmeNode($book, 200, '<p><a class="bib-entry" id="harvey2020"></a>Harvey, David. 2020. Anti-Capitalist Politics.</p>');

    $md = app(BookMarkdownExporter::class)->markdownFor($book);

    expect($md)->toContain('[2020](#harvey2020)')
        ->not->toContain('^harvey2020')
        ->not->toContain('@@HLBLOCK');
});
