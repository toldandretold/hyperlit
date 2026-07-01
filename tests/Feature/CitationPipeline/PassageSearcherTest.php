<?php

/**
 * CitationReview\Phases\PassageSearcher — Phase 4 FTS over source nodes.
 * Extracted from CitationReviewService::searchSourcePassages. search_vector is
 * a STORED generated column (to_tsvector of plainText/content), so seeded nodes
 * are immediately searchable.
 */

use App\Services\CitationReview\Phases\PassageSearcher;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function psDb()
{
    return DB::connection('pgsql_admin');
}

function psSeedNode(string $book, string $nodeId, int $line, string $plain): void
{
    psDb()->table('nodes')->insert([
        'book'       => $book,
        'node_id'    => $nodeId,
        'chunk_id'   => 1,
        'startLine'  => $line,
        'content'    => "<p>{$plain}</p>",
        'plainText'  => $plain,
        'type'       => 'p',
        'raw_json'   => '{}',
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

test('a near-verbatim claim finds its source passage (strategy 1)', function () {
    $src = 'pssrc_' . Str::random(8);
    psSeedNode($src, "{$src}_n1", 100, 'Wealth concentrates when the rate of return exceeds economic growth.');
    psSeedNode($src, "{$src}_n2", 200, 'An unrelated paragraph about maritime shipping logistics.');

    $claims = [[
        'has_source_content' => true,
        'source_book_id'     => $src,
        'truth_claim'        => 'Wealth concentrates when the rate of return exceeds economic growth.',
    ]];

    try {
        app(PassageSearcher::class)->searchSourcePassages($claims);
        expect($claims[0]['source_passages'])->not->toBeEmpty();
        expect($claims[0]['source_passages'][0]['node_id'])->toBe("{$src}_n1");
        expect($claims[0]['source_passages'][0])->toHaveKey('rank');
    } finally {
        psDb()->table('nodes')->where('book', $src)->delete();
    }
});

test('long passages are truncated at 1500 chars with a marker', function () {
    $src = 'pssrc_' . Str::random(8);
    $long = 'quantum entanglement ' . str_repeat('lorem ipsum dolor sit amet ', 120); // > 1500 chars
    psSeedNode($src, "{$src}_n1", 100, $long);

    $claims = [[
        'has_source_content' => true,
        'source_book_id'     => $src,
        'truth_claim'        => 'quantum entanglement lorem ipsum dolor',
    ]];

    try {
        app(PassageSearcher::class)->searchSourcePassages($claims);
        $passage = $claims[0]['source_passages'][0] ?? null;
        expect($passage)->not->toBeNull();
        expect(mb_strlen($passage['text']))->toBeGreaterThan(1500);
        expect($passage['text'])->toContain('[...TRUNCATED]');
    } finally {
        psDb()->table('nodes')->where('book', $src)->delete();
    }
});

test('claims without in-app content are skipped', function () {
    $claims = [[
        'has_source_content' => false,
        'source_book_id'     => null,
        'truth_claim'        => 'anything',
    ]];

    app(PassageSearcher::class)->searchSourcePassages($claims);
    expect($claims[0])->not->toHaveKey('source_passages');
});
