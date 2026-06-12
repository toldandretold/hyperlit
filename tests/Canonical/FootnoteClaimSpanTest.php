<?php

/**
 * Footnote markers attach BACKWARDS: the claim for footnote [N] is the text
 * immediately preceding the marker, clamped at the previous citation marker —
 * never the text after it. (Inline author-date citations keep the
 * sentence-around-the-marker behaviour.)
 *
 * Modelled on the real failure: a three-footnote run where footnote 103's
 * source (SPARC) was "Rejected" for footnote 104's clause about journal
 * publication — a claim it was never cited for.
 */

use App\Services\CitationReviewService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function fcsDb()
{
    return DB::connection('pgsql_admin');
}

test('each footnote in a multi-footnote run gets only the clause BEFORE its marker', function () {
    $book = 'book_canonv_fcs_' . Str::random(8);
    fcsDb()->table('library')->insert([
        'book' => $book, 'title' => 'FCS Test', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    // Bibliography entries the footnotes point at
    foreach (['sparc2023', 'pinfield2014', 'kingsley2013'] as $ref) {
        fcsDb()->table('bibliography')->insert([
            'book' => $book, 'referenceId' => $ref, 'content' => $ref,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    // Footnote definitions linking to the bibliography (pointer style)
    $fnDefs = ['fn103' => 'sparc2023', 'fn104' => 'pinfield2014', 'fn105' => 'kingsley2013'];
    foreach ($fnDefs as $fnId => $ref) {
        fcsDb()->table('footnotes')->insert([
            'book' => $book, 'footnoteId' => $fnId, 'is_citation' => true,
            'content' => '<p>See <a href="#' . $ref . '">' . $ref . '</a>.</p>',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    // The body node: clause A,[103] clause B.[104] Clause C,[105] tail.
    $html = '<p id="10200" data-node-id="' . $book . '_n1">'
        . 'Embargoes frustrate researchers in their efforts at keeping up to date, and they dislike the accepted manuscript,'
        . '<sup id="fn103" fn-count-id="103" class="footnote-ref">103</sup>'
        . ' because actual publication in a journal is critical for a reliable scholarly record.'
        . '<sup id="fn104" fn-count-id="104" class="footnote-ref">104</sup>'
        . ' Additionally, repositories contain all kinds of academic output which is not organized by quality,'
        . '<sup id="fn105" fn-count-id="105" class="footnote-ref">105</sup>'
        . ' as a journal would normally do.</p>';
    fcsDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $book . '_n1', 'chunk_id' => 1, 'startLine' => 1,
        'content' => $html, 'plainText' => strip_tags($html), 'type' => 'p',
        'raw_json' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        $svc = app(CitationReviewService::class);
        $m = new ReflectionMethod($svc, 'parseCitationNodes');
        $m->setAccessible(true);
        $result = $m->invoke($svc, $book);

        expect($result)->toHaveCount(1);
        $spans = $result[0]['extracted_sentences'];

        // fn103's claim: the clause BEFORE marker 103 only
        expect($spans['sparc2023'])->toContain('Embargoes frustrate researchers');
        expect($spans['sparc2023'])->not->toContain('actual publication in a journal');

        // fn104's claim: between markers 103 and 104 — NOT fn103's clause
        expect($spans['pinfield2014'])->toContain('actual publication in a journal is critical');
        expect($spans['pinfield2014'])->not->toContain('Embargoes frustrate');
        expect($spans['pinfield2014'])->not->toContain('repositories contain');

        // fn105's claim: between markers 104 and 105
        expect($spans['kingsley2013'])->toContain('repositories contain all kinds of academic output');
        expect($spans['kingsley2013'])->not->toContain('actual publication');
        expect($spans['kingsley2013'])->not->toContain('as a journal would normally do');

        // Markers in the marked text are FNCITE (directional for the LLM)
        expect($result[0]['marked_text'])->toContain('[FNCITE:sparc2023]');
        expect($result[0]['marked_text'])->not->toContain('[CITE:sparc2023]');
    } finally {
        foreach (['nodes', 'footnotes', 'bibliography', 'library'] as $t) {
            fcsDb()->table($t)->where('book', $book)->delete();
        }
    }
});

test('inline author-date citations keep the sentence-around-the-marker span', function () {
    $book = 'book_canonv_fcs_' . Str::random(8);
    fcsDb()->table('library')->insert([
        'book' => $book, 'title' => 'FCS Test 2', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    fcsDb()->table('bibliography')->insert([
        'book' => $book, 'referenceId' => 'chapman2009', 'content' => 'Chapman 2009',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $html = '<p data-node-id="' . $book . '_n1">First sentence here. Open access mandates accelerated adoption '
        . '(<a href="#chapman2009" class="in-text-citation">Chapman 2009</a>) across European institutions. Last sentence.</p>';
    fcsDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $book . '_n1', 'chunk_id' => 1, 'startLine' => 1,
        'content' => $html, 'plainText' => strip_tags($html), 'type' => 'p',
        'raw_json' => '{}', 'created_at' => now(), 'updated_at' => now(),
    ]);

    try {
        $svc = app(CitationReviewService::class);
        $m = new ReflectionMethod($svc, 'parseCitationNodes');
        $m->setAccessible(true);
        $result = $m->invoke($svc, $book);

        $span = $result[0]['extracted_sentences']['chapman2009'];
        // Whole surrounding sentence — including text AFTER the citation
        expect($span)->toContain('Open access mandates accelerated adoption');
        expect($span)->toContain('across European institutions');
        expect($span)->not->toContain('First sentence');
        expect($result[0]['marked_text'])->toContain('[CITE:chapman2009]');
    } finally {
        foreach (['nodes', 'bibliography', 'library'] as $t) {
            fcsDb()->table($t)->where('book', $book)->delete();
        }
    }
});
