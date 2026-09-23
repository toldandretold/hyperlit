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

// ── Strategy 4: semantic fallback ─────────────────────────────────────────────
// FTS is stem-bound — "enslaving" (stem enslav) never matches "slaves" (stem
// slave), which is how chacko c128's proving passage was missed. When all three
// lexical strategies come up empty, the searcher embeds the claim and runs a
// cosine search over the source's node embeddings. EmbeddingService is faked:
// no test may touch the provider.

function psFakeEmbeddings(?array $queryVector, array $batchVectors = []): void
{
    $fake = new class($queryVector, $batchVectors) extends \App\Services\EmbeddingService {
        public array $embedded = [];
        public function __construct(private ?array $q, private array $b) { parent::__construct(); }
        public function embed(string $text, string $prefix = 'search_document: ', int $maxRetries = 3, int $timeout = parent::TIMEOUT_BACKGROUND): ?array
        {
            $this->embedded[] = $prefix . $text;
            return $this->q;
        }
        public function embedBatch(array $texts, int $maxRetries = 3, int $timeout = parent::TIMEOUT_BACKGROUND): array
        {
            $this->embedded = array_merge($this->embedded, $texts);
            return array_slice(array_pad($this->b, count($texts), null), 0, count($texts));
        }
        public function poolEmbedBatches(array $batches): array
        {
            // Route by prefix: query texts get the query vector, document
            // texts consume the batch list — mirrors the real pooled round.
            $out = [];
            $docs = $this->b;
            foreach ($batches as $key => $texts) {
                $this->embedded = array_merge($this->embedded, $texts);
                $out[$key] = array_map(function ($t) use (&$docs) {
                    return str_starts_with($t, 'search_query: ') ? $this->q : (array_shift($docs) ?: null);
                }, array_values($texts));
            }
            return $out;
        }
    };
    app()->instance(\App\Services\EmbeddingService::class, $fake);
}

function psVector(float $x): array
{
    // 768-dim halfvec; vary the first component so cosine distances differ.
    $v = array_fill(0, 768, 0.001);
    $v[0] = $x;
    return $v;
}

function psSeedEmbedding(string $book, string $nodeId, array $vector): void
{
    $vectorStr = '[' . implode(',', $vector) . ']';
    psDb()->table('nodes')
        ->where('book', $book)->where('node_id', $nodeId)
        ->update(['embedding' => \Illuminate\Support\Facades\DB::raw("'{$vectorStr}'::halfvec")]);
}

test('semantic rung finds the stem-mismatched passage lexical search misses', function () {
    $src = 'pssrc_' . Str::random(8);
    psSeedNode($src, "{$src}_hit", 100, 'For a thousand years we were slaves under foreign rule.');
    psSeedNode($src, "{$src}_miss", 200, 'A completely different paragraph about festival greetings.');
    // The hit node's vector points the same way as the query; the miss is near-orthogonal.
    psSeedEmbedding($src, "{$src}_hit", psVector(1.0));
    psSeedEmbedding($src, "{$src}_miss", psVector(-1.0));
    psFakeEmbeddings(psVector(1.0));

    $claims = [[
        'has_source_content' => true,
        'source_book_id'     => $src,
        // No lexical overlap with the hit node: FTS strategies must all miss.
        'truth_claim'        => 'Enslaving of the population by outsiders preceded colonisation.',
    ]];

    try {
        app(PassageSearcher::class)->searchSourcePassages($claims);
        expect($claims[0]['source_passages'])->not->toBeEmpty();
        expect($claims[0]['source_passages'][0]['node_id'])->toBe("{$src}_hit");
        expect($claims[0]['source_passages'][0]['rank'])->toBeGreaterThan(0.5);
        // The near-orthogonal node is below the similarity floor — filtered.
        $ids = array_column($claims[0]['source_passages'], 'node_id');
        expect($ids)->not->toContain("{$src}_miss");
    } finally {
        psDb()->table('nodes')->where('book', $src)->delete();
        app()->forgetInstance(\App\Services\EmbeddingService::class);
    }
});

test('provider failure degrades to no passages, never throws', function () {
    $src = 'pssrc_' . Str::random(8);
    psSeedNode($src, "{$src}_n1", 100, 'Some source text that lexical search will not match.');
    psSeedEmbedding($src, "{$src}_n1", psVector(1.0));
    psFakeEmbeddings(null); // embed() returns null — provider down

    $claims = [[
        'has_source_content' => true,
        'source_book_id'     => $src,
        'truth_claim'        => 'Entirely unrelated verbiage querying zilch whatsoever.',
    ]];

    try {
        app(PassageSearcher::class)->searchSourcePassages($claims);
        expect($claims[0]['source_passages'])->toBe([]);
    } finally {
        psDb()->table('nodes')->where('book', $src)->delete();
        app()->forgetInstance(\App\Services\EmbeddingService::class);
    }
});

test('a small unembedded source is embedded inline, then searched', function () {
    // The chacko c128 shape: a web_* source fetched mid-review whose
    // GenerateNodeEmbedding jobs are still sitting on the embeddings queue.
    $src = 'pssrc_' . Str::random(8);
    psSeedNode($src, "{$src}_hit", 100, 'For a thousand years we were slaves under foreign rule.');
    psDb()->table('library')->insert([
        'book' => $src, 'title' => 'Inline embed fixture', 'creator' => 'WebFetch',
        'visibility' => 'public', 'type' => 'web_source', 'has_nodes' => true,
        'raw_json' => '{}', 'timestamp' => 1, 'created_at' => now(), 'updated_at' => now(),
    ]);
    psFakeEmbeddings(psVector(1.0), [psVector(1.0)]); // batch returns one vector

    $claims = [[
        'has_source_content' => true,
        'source_book_id'     => $src,
        'truth_claim'        => 'Enslaving of the population by outsiders preceded colonisation.',
    ]];

    try {
        app(PassageSearcher::class)->searchSourcePassages($claims);
        expect($claims[0]['source_passages'])->not->toBeEmpty()
            ->and($claims[0]['source_passages'][0]['node_id'])->toBe("{$src}_hit");
        // The inline pass PERSISTED the vector — next search needs no re-embed.
        $embedded = psDb()->table('nodes')->where('book', $src)->whereNotNull('embedding')->count();
        expect($embedded)->toBe(1);
    } finally {
        psDb()->table('nodes')->where('book', $src)->delete();
        psDb()->table('library')->where('book', $src)->delete();
        app()->forgetInstance(\App\Services\EmbeddingService::class);
    }
});

test('weak lexical matches get the semantic pass too, semantic hits first', function () {
    // The post-fix chacko c128 shape: with the FULL source stored, FTS no
    // longer comes up EMPTY — it returns stopword-grade matches (rank ~0.005
    // on little more than "India") that would win by default while the
    // proving passage (zero stem overlap) never surfaces. Weak best-rank
    // (< 0.02) must trigger the semantic pass, with its hits leading.
    $src = 'pssrc_' . Str::random(8);
    psSeedNode($src, "{$src}_junk", 100, 'A completely different paragraph about festival greetings in India today.');
    psSeedNode($src, "{$src}_hit", 200, 'For a thousand years we were slaves under foreign rule.');
    psSeedEmbedding($src, "{$src}_junk", psVector(-1.0));
    psSeedEmbedding($src, "{$src}_hit", psVector(1.0));
    psFakeEmbeddings(psVector(1.0));

    $claims = [[
        'has_source_content' => true,
        'source_book_id'     => $src,
        // Shares only 'India' with the junk node → OR-strategy rank ≈ 0.009 (< 0.02).
        'truth_claim'        => 'Enslaving of the population by outsiders in India preceded colonisation entirely.',
    ]];

    try {
        app(PassageSearcher::class)->searchSourcePassages($claims);
        $ids = array_column($claims[0]['source_passages'], 'node_id');
        expect($ids[0])->toBe("{$src}_hit");          // semantic hit leads
        expect($ids)->toContain("{$src}_junk");       // weak lexical hit fills the tail
    } finally {
        psDb()->table('nodes')->where('book', $src)->delete();
        app()->forgetInstance(\App\Services\EmbeddingService::class);
    }
});

test('a source whose keyword search works is never embedded at all', function () {
    // The two-pass contract: embedding is paid ONLY for books the lexical
    // ladder failed on. A strong FTS hit must not cost a single provider call
    // — and one needy book shared by several claims is embedded ONCE.
    $strong = 'pssrc_' . Str::random(8);
    psSeedNode($strong, "{$strong}_n1", 100, 'Wealth concentrates when the rate of return exceeds economic growth.');
    $needy = 'pssrc_' . Str::random(8);
    psSeedNode($needy, "{$needy}_n1", 100, 'For a thousand years we were slaves under foreign rule.');
    psDb()->table('library')->insert([
        'book' => $needy, 'title' => 'Needy fixture', 'creator' => 'WebFetch',
        'visibility' => 'public', 'type' => 'web_source', 'has_nodes' => true,
        'raw_json' => '{}', 'timestamp' => 1, 'created_at' => now(), 'updated_at' => now(),
    ]);
    psFakeEmbeddings(psVector(1.0), [psVector(1.0)]);
    $fake = app(\App\Services\EmbeddingService::class);

    $claims = [
        [ // strong FTS — must never touch the provider
            'has_source_content' => true, 'source_book_id' => $strong,
            'truth_claim' => 'Wealth concentrates when the rate of return exceeds economic growth.',
        ],
        [ // two claims against the same unembedded needy book
            'has_source_content' => true, 'source_book_id' => $needy,
            'truth_claim' => 'Enslaving of the population by outsiders preceded colonisation.',
        ],
        [
            'has_source_content' => true, 'source_book_id' => $needy,
            'truth_claim' => 'Bondage of peoples under successive foreign dominions historically.',
        ],
    ];

    try {
        app(PassageSearcher::class)->searchSourcePassages($claims);
        expect($claims[0]['source_passages'][0]['node_id'])->toBe("{$strong}_n1");
        expect($claims[1]['source_passages'][0]['node_id'])->toBe("{$needy}_n1");
        expect($claims[2]['source_passages'][0]['node_id'])->toBe("{$needy}_n1");
        // Provider calls: ONE document batch (the needy book, embedded once,
        // not once per claim) + one query embed per deferred claim. Nothing
        // for the strong-FTS book.
        $docBatches = array_filter($fake->embedded, fn ($t) => str_starts_with($t, 'search_document: '));
        expect(count($docBatches))->toBe(1);
        foreach ($fake->embedded as $t) {
            expect($t)->not->toContain('rate of return'); // strong book never embedded/queried
        }
    } finally {
        psDb()->table('nodes')->whereIn('book', [$strong, $needy])->delete();
        psDb()->table('library')->where('book', $needy)->delete();
        app()->forgetInstance(\App\Services\EmbeddingService::class);
    }
});
