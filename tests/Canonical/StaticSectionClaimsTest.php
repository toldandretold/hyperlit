<?php

/**
 * Static footnote-definition / bibliography nodes must NOT become claim
 * sources. In paste-converted books the footnote definitions are body nodes
 * (<p data-static-content="footnotes">116. Westkamp (2022), p. 1044.</p>)
 * carrying linked in-text-citation anchors — walking them produced junk
 * claims ("Asai (2021) p. 32." → verdict on whether the source cites itself).
 * The real claim lives at the body sentence carrying the <sup> marker.
 */

use App\Services\CitationReviewService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function sscDb()
{
    return DB::connection('pgsql_admin');
}

test('claims come from body nodes, never from static footnote/bibliography sections', function () {
    $book = 'book_canonv_ssc_' . Str::random(8);
    sscDb()->table('library')->insert([
        'book' => $book, 'title' => 'SSC Test', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    sscDb()->table('bibliography')->insert([
        'book' => $book, 'referenceId' => 'westkamp2022', 'content' => 'Westkamp G (2022) ...',
        'created_at' => now(), 'updated_at' => now(),
    ]);
    $mk = fn($nodeId, $line, $html) => [
        'book' => $book, 'node_id' => $nodeId, 'chunk_id' => 1, 'startLine' => $line,
        'content' => $html, 'plainText' => strip_tags($html), 'type' => 'p',
        'created_at' => now(), 'updated_at' => now(),
    ];
    sscDb()->table('nodes')->insert([
        $mk($book . '_body', 1, '<p id="10" data-node-id="' . $book . '_body">Copyright reform stalled across member states <a href="#westkamp2022" class="in-text-citation">2022</a>.</p>'),
        $mk($book . '_fndef', 2, '<p data-static-content="footnotes" id="24200" data-node-id="' . $book . '_fndef">116. Westkamp (<a href="#westkamp2022" class="in-text-citation">2022</a>), p. 1044.</p>'),
        $mk($book . '_bib', 3, '<p data-static-content="bibliography" id="westkamp2022" data-node-id="' . $book . '_bib">Westkamp G (2022) Title. <a href="#x" class="in-text-citation">x</a></p>'),
    ]);

    try {
        $result = app(\App\Services\CitationReview\Phases\CitationParser::class)->parseCitationNodes($book);

        $nodeIds = array_column($result, 'node_id');
        expect($nodeIds)->toContain($book . '_body');
        expect($nodeIds)->not->toContain($book . '_fndef');
        expect($nodeIds)->not->toContain($book . '_bib');
    } finally {
        foreach (['nodes', 'bibliography', 'library'] as $t) {
            sscDb()->table($t)->where('book', $book)->delete();
        }
    }
});
