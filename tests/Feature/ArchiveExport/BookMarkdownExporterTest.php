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

test('relative image sources are absolutized', function () {
    $book = 'bmebook_' . Str::random(8);
    bmeNode($book, 100, '<p><img src="/storage/book-images/x.png" alt="fig"></p>');

    $md = app(BookMarkdownExporter::class)->markdownFor($book);

    expect($md)->toContain('![fig](' . rtrim(config('app.url'), '/') . '/storage/book-images/x.png)');
});
