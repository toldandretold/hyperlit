<?php

/**
 * MULTI-WORK CITATIONS: one claim check PER CITED WORK.
 *
 * A footnote citing "Pedregosa, Scikit-learn…; Wickham, ggplot2…" is N citations sharing one
 * marker. The resolver already resolves each work separately (pool keys ::subN, outcome stored in
 * llm_metadata.sub_citations[i].resolution) — but the review used to collapse them back onto the
 * parent row's single source, verifying the claim against whichever ONE book that row carried.
 * underwood-2016-pdf: an L2-logistic-regression claim verified against an R graphics book at
 * tier: canonical, and the report apologising "the matched source is the 2nd — not independently
 * verified: Scikit-learn". That sentence must never be shown to a paying customer; the fix is to
 * never be in the situation, not to word it better.
 *
 * Contract pinned here:
 *  - MetadataEnricher emits one source entry per cited work (parent + ::subN), each enriched
 *    through the same library path, and the parent lists them in sub_source_refs.
 *  - The PROMOTION GUARD: a sub's book promoted into the parent's foundation_source (the reader's
 *    footnote→source link) must NOT stand in as the primary work's source for review.
 *  - TruthClaimExtractor::expandMultiWorkClaims clones the claim per work — each row verified
 *    individually, unresolved works landing in Unverified Sources under their own type.
 */

use App\Services\CitationReview\Phases\MetadataEnricher;
use App\Services\CitationReview\Phases\TruthClaimExtractor;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function mwDb()
{
    return DB::connection('pgsql_admin');
}

function mwSeed(string $book): array
{
    // The cited works' library rows: scikit-learn (primary, resolved on a rescan) and ggplot2
    // (the sub the scan resolved first).
    $scikit = 'mw_scikit_' . Str::random(6);
    $ggplot = 'mw_ggplot_' . Str::random(6);
    foreach ([
        [$book, 'MW Parent Book'],
        [$scikit, 'Scikit-learn: Machine Learning in Python'],
        [$ggplot, 'ggplot2: Elegant Graphics for Data Analysis'],
    ] as [$id, $title]) {
        mwDb()->table('library')->insert([
            'book' => $id, 'title' => $title, 'visibility' => 'public', 'listed' => false,
            'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
        ]);
    }
    return [$scikit, $ggplot];
}

function mwCleanup(string $book, array $extra): void
{
    mwDb()->table('footnotes')->where('book', $book)->delete();
    mwDb()->table('library')->whereIn('book', array_merge([$book], $extra))->delete();
}

function mwFootnote(string $book, ?string $foundation, ?string $sourceId, string $subBook): void
{
    mwDb()->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => 'fn1', 'is_citation' => true,
        'content' => '<p>Pedregosa et al., "Scikit-learn: Machine Learning in Python," JMLR 12 (2011); '
            . 'Images are produced using Hadley Wickham, ggplot2: Elegant Graphics for Data Analysis (Springer, 2009).</p>',
        'foundation_source' => $foundation,
        'source_id' => $sourceId,
        'llm_metadata' => json_encode([
            'type' => 'journal-article', 'title' => 'Scikit-learn: Machine Learning in Python',
            'authors' => ['Pedregosa, Fabian'], 'year' => 2011,
            'sub_citations' => [[
                'type' => 'book', 'title' => 'ggplot2: Elegant Graphics for Data Analysis',
                'authors' => ['Wickham, Hadley'], 'year' => 2009,
                'resolution' => ['status' => 'matched', 'book' => $subBook],
            ]],
        ]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
}

function mwNodes(): array
{
    return [[
        'node_id' => 'n1',
        'plainText' => 'L2-regularized logistic regression provides simple feature importance estimates.',
        'reference_ids' => ['fn1'],
    ]];
}

test('the enricher emits one source entry per cited work, and the parent lists them', function () {
    $book = 'mw_' . Str::random(8);
    [$scikit, $ggplot] = mwSeed($book);
    // The scan's live state after the eviction fix: the primary matched its own book.
    mwFootnote($book, $scikit, $scikit, $ggplot);
    try {
        $meta = app(MetadataEnricher::class)->enrichCitationMetadata(mwNodes(), $book);

        expect($meta)->toHaveKeys(['fn1', 'fn1::sub1'])
            ->and($meta['fn1']['source_book_id'])->toBe($scikit)
            ->and($meta['fn1']['sub_source_refs'])->toBe(['fn1::sub1'])
            // The sub is enriched from ITS OWN library row, not the parent's.
            ->and($meta['fn1::sub1']['source_book_id'])->toBe($ggplot)
            ->and($meta['fn1::sub1']['title'])->toBe('ggplot2: Elegant Graphics for Data Analysis')
            // …and its work metadata is the SUB's, marked split_from so the "unsplit multi-work"
            // heuristic never fires on the semicolon-carrying citation text.
            ->and($meta['fn1::sub1']['llm_metadata']['title'])->toBe('ggplot2: Elegant Graphics for Data Analysis')
            ->and($meta['fn1::sub1']['llm_metadata']['split_from'])->toBe('fn1');
    } finally {
        mwCleanup($book, [$scikit, $ggplot]);
    }
});

test('THE GUARD: a promoted sub book never stands in as the primary work\'s source', function () {
    // The underwood state: primary never matched (source_id NULL), the scan promoted the
    // resolving sub's book into foundation_source for the reader's footnote link. For review
    // that stand-in IS the wrong-source bug — the primary must read UNRESOLVED, and the sub's
    // book must appear only on the sub's own entry.
    $book = 'mw_' . Str::random(8);
    [$scikit, $ggplot] = mwSeed($book);
    mwFootnote($book, $ggplot, null, $ggplot);
    try {
        $meta = app(MetadataEnricher::class)->enrichCitationMetadata(mwNodes(), $book);

        expect($meta['fn1']['source_book_id'])->toBeNull()
            ->and($meta['fn1']['verified'])->toBeFalse()
            ->and($meta['fn1::sub1']['source_book_id'])->toBe($ggplot);
    } finally {
        mwCleanup($book, [$scikit, $ggplot]);
    }
});

test('a foundation the primary matched ITSELF is kept even when a sub shares it', function () {
    // source_id === foundation_source means the book is the primary's own match — the guard
    // must not strip a genuine resolution just because a sub happens to point at the same book.
    $book = 'mw_' . Str::random(8);
    [$scikit, $ggplot] = mwSeed($book);
    mwFootnote($book, $ggplot, $ggplot, $ggplot);
    try {
        $meta = app(MetadataEnricher::class)->enrichCitationMetadata(mwNodes(), $book);
        expect($meta['fn1']['source_book_id'])->toBe($ggplot);
    } finally {
        mwCleanup($book, [$scikit, $ggplot]);
    }
});

test('expansion clones the claim per cited work; each row is its own verification', function () {
    $book = 'mw_' . Str::random(8);
    [$scikit, $ggplot] = mwSeed($book);
    mwFootnote($book, $scikit, $scikit, $ggplot);
    try {
        $meta = app(MetadataEnricher::class)->enrichCitationMetadata(mwNodes(), $book);
        $claims = [[
            'node_id' => 'n1', 'referenceId' => 'fn1',
            'truth_claim' => 'L2-regularized logistic regression provides simple feature importance estimates.',
            'contextualised_claim' => null, 'claim_source' => 'llm',
            'source_book_id' => $meta['fn1']['source_book_id'],
            'source_title' => $meta['fn1']['title'],
            'llm_metadata' => $meta['fn1']['llm_metadata'],
            'charStart' => 0, 'charEnd' => 10, 'highlightId' => 'HL_x',
            'source_passages' => [], 'llm_verdict' => null,
        ]];

        $out = app(TruthClaimExtractor::class)->expandMultiWorkClaims($claims, $meta);

        expect($out)->toHaveCount(2);
        [$primary, $sub] = $out;
        expect($primary['referenceId'])->toBe('fn1')
            ->and($primary['cited_work_position'])->toBe(1)
            ->and($primary['cited_work_total'])->toBe(2)
            ->and($primary['source_book_id'])->toBe($scikit);
        expect($sub['referenceId'])->toBe('fn1::sub1')
            ->and($sub['cited_work_position'])->toBe(2)
            ->and($sub['source_book_id'])->toBe($ggplot)
            ->and($sub['source_title'])->toBe('ggplot2: Elegant Graphics for Data Analysis')
            // The claim itself is UNCHANGED — same words, same span, same highlight anchor.
            ->and($sub['truth_claim'])->toBe($primary['truth_claim'])
            ->and($sub['highlightId'])->toBe('HL_x')
            ->and($sub['expanded_work'])->toBeTrue();
    } finally {
        mwCleanup($book, [$scikit, $ggplot]);
    }
});

test('an UNRESOLVED sub still gets its own row — reported unfound under its own type', function () {
    // "Searched, not found" is a finding about that work (the fabrication banners key off its
    // type). Collapsing it into the parent hid exactly the works most worth chasing.
    $book = 'mw_' . Str::random(8);
    [$scikit, $ggplot] = mwSeed($book);
    mwDb()->table('footnotes')->insert([
        'book' => $book, 'footnoteId' => 'fn1', 'is_citation' => true,
        'content' => '<p>Primary work; Phantom Journal Article, "Made Up Entirely," J. Nowhere 3 (2020).</p>',
        'foundation_source' => $scikit, 'source_id' => $scikit,
        'llm_metadata' => json_encode([
            'type' => 'journal-article', 'title' => 'Scikit-learn: Machine Learning in Python',
            'sub_citations' => [[
                'type' => 'journal-article', 'title' => 'Made Up Entirely',
                'resolution' => ['status' => 'no_match'],
            ]],
        ]),
        'created_at' => now(), 'updated_at' => now(),
    ]);
    try {
        $meta = app(MetadataEnricher::class)->enrichCitationMetadata(mwNodes(), $book);

        expect($meta['fn1::sub1']['source_book_id'])->toBeNull()
            ->and($meta['fn1::sub1']['verified'])->toBeFalse()
            ->and($meta['fn1::sub1']['llm_metadata']['title'])->toBe('Made Up Entirely')
            ->and($meta['fn1::sub1']['llm_metadata']['type'])->toBe('journal-article');
    } finally {
        mwCleanup($book, [$scikit, $ggplot]);
    }
});

test('a sub that resolved to the SAME book as the primary is not duplicated', function () {
    $book = 'mw_' . Str::random(8);
    [$scikit, $ggplot] = mwSeed($book);
    mwFootnote($book, $scikit, $scikit, $scikit);   // sub resolved to the primary's book
    try {
        $meta = app(MetadataEnricher::class)->enrichCitationMetadata(mwNodes(), $book);
        $claims = [[
            'node_id' => 'n1', 'referenceId' => 'fn1', 'truth_claim' => 'A claim.',
            'source_book_id' => $meta['fn1']['source_book_id'],
            'llm_metadata' => $meta['fn1']['llm_metadata'],
        ]];
        $out = app(TruthClaimExtractor::class)->expandMultiWorkClaims($claims, $meta);
        expect($out)->toHaveCount(1);
    } finally {
        mwCleanup($book, [$scikit, $ggplot]);
    }
});
