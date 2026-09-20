<?php

/**
 * CitationReview\Phases\TruthClaimExtractor — Phase 3.
 * Extracted from CitationReviewService::extractTruthClaims. The anti-
 * hallucination property (claims must appear verbatim; hallucinated refIds are
 * dropped) is the thing worth pinning. Mock LlmService::extractTruthClaimsBatch.
 */

use App\Services\CitationReview\Phases\TruthClaimExtractor;
use App\Services\CitationReview\Support\TextNormaliser;
use App\Services\LlmService;

/**
 * @param  array  $batchReturn  what extractTruthClaimsBatch returns
 * @param  array|null  $contextualiseReturn  what contextualiseClaimsBatch returns, keyed by CLAIM
 *   INDEX (the second pass rewrites rescued claims in place). Null = the pass returns nothing, so
 *   rescued claims keep their raw sentence.
 */
function extractorWith(array $batchReturn, ?array $contextualiseReturn = null): TruthClaimExtractor
{
    $llm = Mockery::mock(LlmService::class);
    $llm->shouldReceive('extractTruthClaimsBatch')->andReturn($batchReturn);
    $llm->shouldReceive('contextualiseClaimsBatch')->andReturnUsing(
        fn (array $items) => $contextualiseReturn ?? []
    );
    return new TruthClaimExtractor($llm, new TextNormaliser());
}

/** Records what contextualiseClaimsBatch was asked to rewrite, so the FILTER can be asserted. */
function extractorSpying(array $batchReturn, array &$seenItems): TruthClaimExtractor
{
    $llm = Mockery::mock(LlmService::class);
    $llm->shouldReceive('extractTruthClaimsBatch')->andReturn($batchReturn);
    $llm->shouldReceive('contextualiseClaimsBatch')->andReturnUsing(function (array $items) use (&$seenItems) {
        $seenItems = $items;
        return [];
    });
    return new TruthClaimExtractor($llm, new TextNormaliser());
}

function oneNode(): array
{
    return [[
        'node_id'             => 'n1',
        'marked_text'         => 'The sky is blue [CITE:r1] according to science.',
        'plainText'           => 'The sky is blue according to science.',
        'reference_ids'       => ['r1'],
        'preceding_context'   => '',
        'citationPositions'   => ['r1' => 15],
        'extracted_sentences' => [],
    ]];
}

test('a verbatim claim is kept and enriched from citation metadata', function () {
    $svc = extractorWith([[
        ['referenceId' => 'r1', 'truth_claim' => 'The sky is blue'],
    ]]);
    $meta = ['r1' => ['verified' => true, 'title' => 'Sky Studies', 'verification_tier' => 'local']];

    $emitted = [];
    $claims = $svc->extractTruthClaims(oneNode(), $meta, function ($m) use (&$emitted) { $emitted[] = $m; });

    expect($claims)->toHaveCount(1);
    expect($claims[0]['truth_claim'])->toBe('The sky is blue');
    expect($claims[0]['source_title'])->toBe('Sky Studies');
    expect($claims[0]['verified_source'])->toBeTrue();
    expect($emitted[0])->toContain('Processing nodes 1-1 of 1');
});

test('a non-verbatim (hallucinated) claim is discarded', function () {
    $svc = extractorWith([[
        ['referenceId' => 'r1', 'truth_claim' => 'The grass is purple and made of code'],
    ]]);
    $claims = $svc->extractTruthClaims(oneNode(), [], fn($m) => null);
    expect($claims)->toBeEmpty();
});

test('a claim citing a refId not present in the node is dropped', function () {
    $svc = extractorWith([[
        ['referenceId' => 'not_in_node', 'truth_claim' => 'The sky is blue'],
    ]]);
    $claims = $svc->extractTruthClaims(oneNode(), [], fn($m) => null);
    expect($claims)->toBeEmpty();
});

/**
 * Regression, 2026-09-18 phase2 run: 87 claims were discarded as "not found verbatim" and that was
 * the DOMINANT cause of a correctly-linked citation producing no claim at all (chacko-2025-paste:
 * 4 drops, 4 orphaned citations — exact correspondence).
 *
 * Cause: when a citation sits inside a parenthetical that ALSO carries prose, neither comparison
 * base can represent what the model legitimately returns. The text reads "John Ruggie (Bhagwati and
 * Ruggie 1984)" with only "1984" anchored, so the marked base becomes "(Bhagwati and Ruggie )"
 * while plainText still reads "(1982)" after "Kissinger". The model drops the marker and keeps the
 * prose — a third form matching neither.
 */
test('a claim whose citation parentheticals are rendered differently is KEPT', function () {
    // Real text and real model output from nicholls-nieo-paste.
    $node = [[
        'node_id'     => 'n1',
        'marked_text' => 'From the imperialist Henry Kissinger [CITE:kissinger1982], to the theorist of '
            . 'embedded liberalism, John Ruggie (Bhagwati and Ruggie [CITE:bhagwati1984]), and the '
            . 'historical materialist Robert W. Cox (Cox [CITE:cox1981]), all agreed.',
        'plainText'   => 'From the imperialist Henry Kissinger (1982), to the theorist of embedded '
            . 'liberalism, John Ruggie (Bhagwati and Ruggie 1984), and the historical materialist '
            . 'Robert W. Cox (Cox 1981), all agreed.',
        'reference_ids'       => ['kissinger1982', 'bhagwati1984', 'cox1981'],
        'preceding_context'   => '',
        'citationPositions'   => ['kissinger1982' => 36, 'bhagwati1984' => 110, 'cox1981' => 160],
        'extracted_sentences' => [],
    ]];

    $svc = extractorWith([[
        [
            'referenceId' => 'kissinger1982',
            'truth_claim' => 'From the imperialist Henry Kissinger, to the theorist of embedded '
                . 'liberalism, John Ruggie (Bhagwati and Ruggie 1984), and the historical '
                . 'materialist Robert W. Cox (Cox 1981), all agreed.',
        ],
    ]]);

    $claims = $svc->extractTruthClaims($node, [], fn ($m) => null);

    expect($claims)->toHaveCount(1)
        ->and($claims[0]['referenceId'])->toBe('kissinger1982');
});

test('a mid-sentence citation removed by the model is KEPT', function () {
    // chacko-2025-paste: "(Jessop, 2013)" sits mid-sentence, and the model returns the sentence
    // without it. This produced an orphaned citation on a substantive claim.
    $node = [[
        'node_id'     => 'n1',
        'marked_text' => "The regime's 'accumulation strategy' (Jessop, [CITE:jessop2013]) to foster "
            . 'economic growth also has autocratising implications.',
        'plainText'   => "The regime's 'accumulation strategy' (Jessop, 2013) to foster economic "
            . 'growth also has autocratising implications.',
        'reference_ids'       => ['jessop2013'],
        'preceding_context'   => '',
        'citationPositions'   => ['jessop2013' => 37],
        'extracted_sentences' => [],
    ]];

    $svc = extractorWith([[
        [
            'referenceId' => 'jessop2013',
            'truth_claim' => "The regime's 'accumulation strategy' to foster economic growth also "
                . 'has autocratising implications.',
        ],
    ]]);

    expect($svc->extractTruthClaims($node, [], fn ($m) => null))->toHaveCount(1);
});

test('the relaxation does NOT let an invented claim through', function () {
    // The anti-hallucination property must survive the new tier: stripping year-parentheses from
    // both sides keeps every prose word and its order intact, so unrelated prose still fails.
    $node = [[
        'node_id'             => 'n1',
        'marked_text'         => "The regime's 'accumulation strategy' (Jessop, [CITE:jessop2013]) matters.",
        'plainText'           => "The regime's 'accumulation strategy' (Jessop, 2013) matters.",
        'reference_ids'       => ['jessop2013'],
        'preceding_context'   => '',
        'citationPositions'   => ['jessop2013' => 37],
        'extracted_sentences' => [],
    ]];

    $svc = extractorWith([[
        ['referenceId' => 'jessop2013', 'truth_claim' => 'The regime abolished the central bank in 2013.'],
    ]]);

    expect($svc->extractTruthClaims($node, [], fn ($m) => null))->toBeEmpty();
});

test('a claim that is NOTHING but a citation parenthetical is discarded', function () {
    // Stripping would reduce it to an empty string, and mb_strpos($haystack, '') reports a match —
    // which would accept anything at all.
    $node = [[
        'node_id'             => 'n1',
        'marked_text'         => 'Growth slowed (Jessop, [CITE:jessop2013]).',
        'plainText'           => 'Growth slowed (Jessop, 2013).',
        'reference_ids'       => ['jessop2013'],
        'preceding_context'   => '',
        'citationPositions'   => ['jessop2013' => 23],
        'extracted_sentences' => [],
    ]];

    $svc = extractorWith([[
        ['referenceId' => 'jessop2013', 'truth_claim' => '(Smith, 1999)'],
    ]]);

    expect($svc->extractTruthClaims($node, [], fn ($m) => null))->toBeEmpty();
});

/**
 * Variant B (config `services.citation_review.span_backfill`): when the model fails to reproduce
 * text we already computed, use OUR span instead of dropping the citation.
 *
 * CitationParser computes each citation's sentence deterministically and the prompt is HANDED it
 * ("USE IT"); asking the model to copy it back is redundant, and the echo is where both observed
 * failures come from — an imperfect copy and outright omission. Either way the citation went
 * unreviewed, which is strictly worse than reviewing the span the model was asked to copy.
 */
function spanNode(): array
{
    return [[
        'node_id'     => 'n1',
        'marked_text' => 'Alpha claims X [CITE:a2001]. Beta asserts Y [CITE:b2002].',
        'plainText'   => 'Alpha claims X (A 2001). Beta asserts Y (B 2002).',
        'reference_ids'       => ['a2001', 'b2002'],
        'preceding_context'   => '',
        'citationPositions'   => ['a2001' => 15, 'b2002' => 40],
        'extracted_sentences' => [
            'a2001' => 'Alpha claims X (A 2001).',
            'b2002' => 'Beta asserts Y (B 2002).',
        ],
    ]];
}

test('span_backfill is OFF by default — the historical behaviour is preserved', function () {
    expect(config('services.citation_review.span_backfill'))->toBeFalse();

    // Model returns nothing for b2002 at all.
    $svc = extractorWith([[['referenceId' => 'a2001', 'truth_claim' => 'Alpha claims X']]]);
    $claims = $svc->extractTruthClaims(spanNode(), [], fn ($m) => null);

    expect($claims)->toHaveCount(1)
        ->and($claims[0]['claim_source'])->toBe('llm');
});

test('a citation the model OMITTED is backfilled from our span', function () {
    config(['services.citation_review.span_backfill' => true]);

    $svc = extractorWith([[['referenceId' => 'a2001', 'truth_claim' => 'Alpha claims X']]]);
    $claims = $svc->extractTruthClaims(spanNode(), [], fn ($m) => null);

    expect($claims)->toHaveCount(2);
    $back = collect($claims)->firstWhere('referenceId', 'b2002');
    expect($back['claim_source'])->toBe('span_backfill')
        ->and($back['truth_claim'])->toBe('Beta asserts Y (B 2002).')
        // It must locate itself in the text, or the highlight has nothing to attach to.
        ->and(mb_substr(spanNode()[0]['plainText'], $back['charStart'], $back['charEnd'] - $back['charStart']))
        ->toBe('Beta asserts Y (B 2002).');
});

test('a claim the model MANGLED falls back to our span instead of being dropped', function () {
    config(['services.citation_review.span_backfill' => true]);

    // "sidelided" — a real corruption observed in the 2026-09-19 run. Previously dropped outright.
    $svc = extractorWith([[
        ['referenceId' => 'a2001', 'truth_claim' => 'Alpha claimed X but was sidelided entirely'],
        ['referenceId' => 'b2002', 'truth_claim' => 'Beta asserts Y'],
    ]]);
    $claims = $svc->extractTruthClaims(spanNode(), [], fn ($m) => null);

    expect($claims)->toHaveCount(2);
    expect(collect($claims)->firstWhere('referenceId', 'a2001'))
        ->claim_source->toBe('span_fallback')
        ->truth_claim->toBe('Alpha claims X (A 2001).');
    expect(collect($claims)->firstWhere('referenceId', 'b2002'))->claim_source->toBe('llm');
});

test('a WHOLE-NODE extraction failure still yields claims for every citation', function () {
    config(['services.citation_review.span_backfill' => true]);

    // The batch returned null for this node — previously every citation in the paragraph was lost.
    $svc = extractorWith([null]);
    $claims = $svc->extractTruthClaims(spanNode(), [], fn ($m) => null);

    expect($claims)->toHaveCount(2)
        ->and(collect($claims)->pluck('claim_source')->unique()->all())->toBe(['span_backfill']);
});

test('backfilled claims carry NO contextualisation, and that is visible', function () {
    config(['services.citation_review.span_backfill' => true]);

    $svc = extractorWith([[]]);
    $claims = $svc->extractTruthClaims(spanNode(), [], fn ($m) => null);

    // ClaimVerifier verifies contextualised_claim ?? truth_claim, so these are judged on the raw
    // sentence. An anaphoric one ("The same is argued by X") therefore verifies weaker — the
    // claim_source field is what lets the study attribute that to US rather than to the citation.
    foreach ($claims as $c) {
        expect($c['contextualised_claim'])->toBe($c['truth_claim'])
            ->and($c['claim_source'])->toBe('span_backfill');
    }
});

test('a citation with no computable span is NOT invented', function () {
    config(['services.citation_review.span_backfill' => true]);

    $node = spanNode();
    unset($node[0]['extracted_sentences']['b2002']);

    $svc = extractorWith([[['referenceId' => 'a2001', 'truth_claim' => 'Alpha claims X']]]);
    $claims = $svc->extractTruthClaims($node, [], fn ($m) => null);

    expect($claims)->toHaveCount(1)
        ->and($claims[0]['referenceId'])->toBe('a2001');
});

/**
 * The contextualisation pass: rescued claims get the one field they lack.
 *
 * A span-sourced claim is our own sentence, so nothing resolved its pronouns — and ClaimVerifier
 * judges `contextualised_claim ?? truth_claim`. Without this pass, "The same argument is made by X"
 * reaches verification without ever stating the argument, and the verdict describes OUR text rather
 * than the citation. That was the measured cost of variant B.
 */
function anaphoricNode(): array
{
    return [[
        'node_id'     => 'n1',
        'marked_text' => 'The NIEO demanded indexed commodity prices. The same argument is made by Prebisch [CITE:p1980].',
        'plainText'   => 'The NIEO demanded indexed commodity prices. The same argument is made by Prebisch (1980).',
        'reference_ids'       => ['p1980'],
        'preceding_context'   => 'Developing countries sought structural reform of trade.',
        'citationPositions'   => ['p1980' => 78],
        'extracted_sentences' => ['p1980' => 'The same argument is made by Prebisch (1980).'],
    ]];
}

test('an ANAPHORIC rescued claim is sent for contextualisation and rewritten', function () {
    config(['services.citation_review.span_backfill' => true]);

    $svc = extractorWith([[]], [0 => 'Commodity prices should be indexed to manufactured goods.']);
    $claims = $svc->extractTruthClaims(anaphoricNode(), [], fn ($m) => null);

    expect($claims)->toHaveCount(1);
    // truth_claim stays the verbatim sentence; only the verified field is resolved.
    expect($claims[0]['truth_claim'])->toBe('The same argument is made by Prebisch (1980).')
        ->and($claims[0]['contextualised_claim'])->toBe('Commodity prices should be indexed to manufactured goods.')
        ->and($claims[0]['claim_source'])->toBe('span_backfill');
});

test('a SELF-CONTAINED rescued claim is never sent — the filter is what makes this cheap', function () {
    config(['services.citation_review.span_backfill' => true]);

    $node = [[
        'node_id'     => 'n1',
        'marked_text' => 'Net inflows of foreign direct investment fell from 2.4% of GDP to 0.8% [CITE:wb2025].',
        'plainText'   => 'Net inflows of foreign direct investment fell from 2.4% of GDP to 0.8% (WB 2025).',
        'reference_ids'       => ['wb2025'],
        'preceding_context'   => '',
        'citationPositions'   => ['wb2025' => 70],
        'extracted_sentences' => ['wb2025' => 'Net inflows of foreign direct investment fell from 2.4% of GDP to 0.8% (WB 2025).'],
    ]];

    $seen = [];
    $svc = extractorSpying([[]], $seen);
    $claims = $svc->extractTruthClaims($node, [], fn ($m) => null);

    expect($claims)->toHaveCount(1)
        ->and($seen)->toBe([]); // nothing requested, so nothing paid for
});

test('an LLM-sourced claim is NOT re-contextualised — the model already did it', function () {
    config(['services.citation_review.span_backfill' => true]);

    $seen = [];
    $svc = extractorSpying([[
        [
            'referenceId' => 'p1980',
            'truth_claim' => 'The same argument is made by Prebisch',
            'contextualised_claim' => 'Commodity prices should be indexed.',
        ],
    ]], $seen);
    $claims = $svc->extractTruthClaims(anaphoricNode(), [], fn ($m) => null);

    expect($claims[0]['claim_source'])->toBe('llm')
        ->and($claims[0]['contextualised_claim'])->toBe('Commodity prices should be indexed.')
        ->and($seen)->toBe([]);
});

test('a FAILED contextualisation leaves the claim intact rather than losing it', function () {
    config(['services.citation_review.span_backfill' => true]);

    // The pass can only improve a rescued claim. If the call fails or returns nothing, the raw
    // sentence stays — which is exactly the pre-existing behaviour, so there is no new failure mode.
    $svc = extractorWith([[]], [0 => null]);
    $claims = $svc->extractTruthClaims(anaphoricNode(), [], fn ($m) => null);

    expect($claims)->toHaveCount(1)
        ->and($claims[0]['contextualised_claim'])->toBe('The same argument is made by Prebisch (1980).');
});

test('the pass reports how many claims it is rewriting', function () {
    config(['services.citation_review.span_backfill' => true]);

    $msgs = [];
    $svc = extractorWith([[]], [0 => 'Resolved.']);
    $svc->extractTruthClaims(anaphoricNode(), [], function ($m) use (&$msgs) { $msgs[] = $m; });

    expect(collect($msgs)->contains(fn ($m) => str_contains($m, 'Contextualising 1 rescued claim')))->toBeTrue();
});
