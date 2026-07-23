<?php

/**
 * BackendHighlightService::createHighlight writes the verdict sub-book's nodes
 * with a real INSERT into `nodes` — a table whose raw_json column was DROPPED
 * (migration 2026_07_13). The 2026-07 sweep missed this backend writer, so
 * every citation-review verification highlight 500'd on prod
 * ("column raw_json of relation nodes does not exist") AFTER the LLM spend.
 * This locks the insert against the live schema.
 */

use App\Services\BackendHighlightService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function bhnDb()
{
    return DB::connection('pgsql_admin');
}

test('createHighlight inserts sub-book nodes against the current nodes schema', function () {
    $book = 'book_canonv_bhn_' . Str::random(8);
    $nodeId = $book . '_n1';
    bhnDb()->table('library')->insert([
        'book' => $book, 'title' => 'BHN Test', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    bhnDb()->table('nodes')->insert([
        'book' => $book, 'node_id' => $nodeId, 'chunk_id' => 1, 'startLine' => 100,
        'content' => '<p data-node-id="' . $nodeId . '">The McCracken report promoted disciplinary policies.</p>',
        'plainText' => 'The McCracken report promoted disciplinary policies.', 'type' => 'p',
        'created_at' => now(), 'updated_at' => now(),
    ]);

    $highlightId = 'HL_' . abs(crc32($nodeId . 'test'));
    $subBookId = null;

    try {
        $result = app(BackendHighlightService::class)->createHighlight([
            'bookId'         => $book,
            'nodeId'         => $nodeId,
            'text'           => 'The McCracken report promoted disciplinary policies.',
            'highlightId'    => $highlightId,
            'creator'        => 'AIreview:test-model',
            'annotation'     => 'Confirmed — test',
            'subBookContent' => [
                ['type' => 'p', 'content' => '<p><strong>Verdict: Confirmed</strong></p>', 'plainText' => 'Verdict: Confirmed'],
                ['type' => 'p', 'content' => '<p><strong>Claim:</strong> test claim</p>', 'plainText' => 'Claim: test claim'],
            ],
            'subBookTitle'   => 'AI Review: Confirmed',
        ]);

        expect($result)->toBe($highlightId);

        $subBookId = bhnDb()->table('hyperlights')
            ->where('book', $book)->where('hyperlight_id', $highlightId)
            ->value('sub_book_id');
        expect($subBookId)->not->toBeNull();

        $subNodes = bhnDb()->table('nodes')->where('book', $subBookId)->orderBy('startLine')->get();
        expect($subNodes)->toHaveCount(2);
        expect($subNodes[0]->plainText)->toBe('Verdict: Confirmed');
    } finally {
        bhnDb()->table('hyperlights')->where('book', $book)->delete();
        if ($subBookId) {
            bhnDb()->table('nodes')->where('book', $subBookId)->delete();
            bhnDb()->table('library')->where('book', $subBookId)->delete();
        }
        bhnDb()->table('nodes')->where('book', $book)->delete();
        bhnDb()->table('library')->where('book', $book)->delete();
    }
});
