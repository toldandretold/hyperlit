<?php

/**
 * The converter emits sup markers with fn-count-id BEFORE id:
 *   <sup class="footnote-ref" fn-count-id="2" fn-section-id="1" id="seq1_Fn…">
 * A plain /\bid="/ extraction matches the id=" tail of fn-count-id=" (hyphen
 * is a word boundary), captures the count ("2") instead of the footnoteId, and
 * every marker fails the footnoteMap lookup — the parser reports 0 citation
 * nodes and the whole review completes empty (the prod import_1784794368772
 * failure: 73 citation footnotes, 0 claims, no report, no email).
 */

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function fsaoDb()
{
    return DB::connection('pgsql_admin');
}

test('sup markers with fn-count-id before id still resolve to their footnote', function () {
    $book = 'book_canonv_fsao_' . Str::random(8);
    fsaoDb()->table('library')->insert([
        'book' => $book, 'title' => 'FSAO Test', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    fsaoDb()->table('bibliography')->insert([
        'book' => $book, 'referenceId' => 'ruggie1982', 'content' => 'Ruggie 1982',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $fnId = 'seq1_Fn1784794381820_3d7s';
    fsaoDb()->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => $fnId, 'is_citation' => true,
        'content' => '<p>See <a href="#ruggie1982">Ruggie 1982</a>.</p>',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    // Real prod attribute order: fn-count-id and fn-section-id BEFORE id.
    $html = '<p data-node-id="' . $book . '_n1">'
        . 'Embedded liberalism reconciled openness with domestic stability,'
        . '<sup class="footnote-ref" fn-count-id="2" fn-section-id="1" id="' . $fnId . '">2</sup>'
        . ' shaping the postwar order.</p>';
    fsaoDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $book . '_n1', 'chunk_id' => 1, 'startLine' => 1,
        'content' => $html, 'plainText' => strip_tags($html), 'type' => 'p',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        $result = app(\App\Services\CitationReview\Phases\CitationParser::class)->parseCitationNodes($book);

        expect($result)->toHaveCount(1);
        expect($result[0]['reference_ids'])->toContain('ruggie1982');
        expect($result[0]['marked_text'])->toContain('[FNCITE:ruggie1982]');
        expect($result[0]['citationPositions'])->toHaveKey('ruggie1982');
        expect($result[0]['extracted_sentences']['ruggie1982'])
            ->toContain('Embedded liberalism reconciled openness');
    } finally {
        foreach (['nodes', 'footnotes', 'bibliography', 'library'] as $t) {
            fsaoDb()->table($t)->where('book', $book)->delete();
        }
    }
});
