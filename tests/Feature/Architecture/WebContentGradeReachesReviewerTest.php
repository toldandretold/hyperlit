<?php

/**
 * REVIEW GATE — fetched web content carries a grade, and the grade reaches the
 * reviewer.
 *
 * The invariant: the citation reviewer must never be shown text without being
 * told what that text actually is. The failure it prevents is subtle and
 * expensive — we hand the model nav-rail soup under the header "PASSAGES FROM
 * SOURCE TEXT", and it renders a confident verdict as though it had read the
 * work. The verdict then looks like a finding about the citation when it is
 * really a finding about our extraction.
 *
 * The chain this gate protects, end to end:
 *   WebTextAcquirer grades the text
 *     -> WebFetchService stores the grade on library.completeness(_reason)
 *       -> MetadataEnricher lifts it onto the claim as source_completeness(_reason)
 *         -> ClaimVerifier puts it in the prompt before any source text
 *
 * Every link was already in place except the grading and the last step, which
 * is why all 261 claims of one chacko run carried source_completeness = NULL
 * and the reviewer's do-not-reject-on-absence warning never fired once.
 */

use App\Services\CitationReview\Phases\ClaimVerifier;
use App\Services\WebContent\WebTextAcquirer;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    // This gate asserts what the prompt SAYS, which is decided before any model
    // is called. Without the fake, each case spends ~5-13s on real API calls
    // (plus LlmService's five retries) to learn nothing the gate looks at.
    Http::fake(['*' => Http::response(['choices' => [['message' => ['content' => '[]']]]], 200)]);
});

test('every acquirer grade has an honest description', function () {
    // A grade with no description would reach the prompt as a silent gap, so
    // this enumerates EVERY declared grade by reflection rather than a list
    // that can fall behind the class.
    $declared = array_filter(
        (new ReflectionClass(WebTextAcquirer::class))->getConstants(),
        fn ($value, $name) => str_starts_with($name, 'GRADE_'),
        ARRAY_FILTER_USE_BOTH,
    );

    expect($declared)->not->toBeEmpty();

    foreach ($declared as $name => $grade) {
        expect(WebTextAcquirer::describeGrade($grade))
            ->toBeString()
            ->not->toBe('', "{$name} has no description");
    }
});

test('an extract is never described as the work itself', function () {
    // The distinction the whole change exists for.
    expect(WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_ARTICLE_EXTRACT))
        ->toContain('EXTRACT')
        ->and(WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_ARTICLE_EXTRACT))
        ->toContain('not all of it');

    expect(WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_FULL_TEXT))
        ->toContain('full text');
});

test('non-text grades are described as NOT article content', function () {
    foreach ([
        WebTextAcquirer::GRADE_METADATA_ONLY,
        WebTextAcquirer::GRADE_BLOCKED,
        WebTextAcquirer::GRADE_DEAD,
        WebTextAcquirer::GRADE_UNREACHABLE,
    ] as $grade) {
        expect(WebTextAcquirer::describeGrade($grade))->toContain('NOT article content');
    }
});

test('only text-bearing grades are treated as usable', function () {
    // Asserted as the NON-usable set, so adding a text-bearing grade (a
    // transcript, say) does not need this edited — but adding a grade that
    // carries no readable text does.
    expect(WebTextAcquirer::USABLE_GRADES)->toEqualCanonicalizing([
        WebTextAcquirer::GRADE_FULL_TEXT,
        WebTextAcquirer::GRADE_ARTICLE_EXTRACT,
        WebTextAcquirer::GRADE_THIN_EXTRACT,
        WebTextAcquirer::GRADE_TRANSCRIPT,
    ]);

    // Nothing we could not read may be stored as source text. A
    // foreign-language source belongs here: the only translation available is
    // machine-made, which is not evidence of what the source said.
    foreach ([
        WebTextAcquirer::GRADE_BLOCKED,
        WebTextAcquirer::GRADE_DEAD,
        WebTextAcquirer::GRADE_IRRELEVANT,
        WebTextAcquirer::GRADE_METADATA_ONLY,
        WebTextAcquirer::GRADE_UNREACHABLE,
        WebTextAcquirer::GRADE_FOREIGN_LANGUAGE,
    ] as $grade) {
        expect(in_array($grade, WebTextAcquirer::USABLE_GRADES, true))->toBeFalse();
    }
});

test('the verify prompt states the provenance BEFORE any source text', function () {
    $material = verifyMaterialFor([
        'source_completeness' => 'partial',
        'source_completeness_reason' => WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_ARTICLE_EXTRACT),
        'match_method' => 'web_fetch',
    ]);

    expect($material)->toContain('HOW THIS SOURCE TEXT WAS OBTAINED');

    $provenanceAt = strpos($material, 'HOW THIS SOURCE TEXT WAS OBTAINED');
    $passagesAt = strpos($material, 'PASSAGES');

    expect($provenanceAt)->toBeLessThan($passagesAt);
    expect($material)->toContain('MAIN-CONTENT EXTRACT');
});

test('a web-search-found source is declared a GUESS, not an identification', function () {
    // brave_search resolution picks the best title match from a web search. The
    // reviewer used to see it identically to a DOI-matched full text.
    $material = verifyMaterialFor([
        'source_completeness' => 'partial',
        'source_completeness_reason' => WebTextAcquirer::describeGrade(WebTextAcquirer::GRADE_ARTICLE_EXTRACT),
        'match_method' => 'brave_search',
    ]);

    expect($material)->toContain('SEARCHING THE WEB')
        ->and($material)->toContain('GUESS');
});

test('a DOI-matched source says so, so the reviewer can trust the identity', function () {
    $material = verifyMaterialFor(['match_method' => 'doi']);

    expect($material)->toContain('matched to the citation by DOI');
});

test('web_status rejected reaches the prompt as an untrusted-source warning', function () {
    // This is computed, rendered in the human report, and used to stop at the
    // report — the model was still handed the wrong article's text as though it
    // were the source.
    $material = verifyMaterialFor(['web_status' => 'rejected', 'match_method' => 'web_fetch']);

    expect($material)->toContain('DO NOT TRUST THE TEXT ABOVE AS THIS SOURCE')
        ->and($material)->toContain('DIFFERENT article')
        // Must not invite a rejection: a mismatched URL says nothing about
        // whether the cited work is genuine.
        ->and($material)->toContain('do NOT mark the claim rejected');
});

/**
 * Run ClaimVerifier's prompt assembly over one synthetic claim and return the
 * source material it would send. Uses the real phase (no LLM: the batch call is
 * reached only after material is built, and we read source_material_sent, which
 * the phase records before calling out).
 *
 * @param  array<string, mixed>  $overrides
 */
function verifyMaterialFor(array $overrides = []): string
{
    $claim = array_merge([
        'node_id' => 'n1',
        'referenceId' => 'ref1',
        'truth_claim' => 'The court found the demolitions unlawful.',
        'contextualised_claim' => 'The court found the demolitions unlawful.',
        'source_title' => 'Bulldozing homes was unlawful, says HC',
        'source_author' => 'Scroll Staff',
        'source_year' => 2023,
        'source_type' => 'web_source',
        'abstract' => null,
        'source_passages' => [
            ['node_id' => 's1', 'text' => 'The High Court held that the demolition of 73 homes was unlawful.', 'rank' => 0.9],
        ],
        'evidence_type' => 'none',
        'has_source_content' => true,
        'source_book_id' => 'web_abc',
        'source_completeness' => null,
        'source_completeness_reason' => null,
        'match_method' => null,
        'web_status' => null,
        'llm_verdict' => null,
        'source_material_sent' => null,
    ], $overrides);

    $claims = [$claim];

    // The phase mutates $claims in place and records source_material_sent
    // before the LLM batch. A null LLM response only affects llm_verdict.
    app(ClaimVerifier::class)->verifyClaims($claims, fn () => null);

    return (string) ($claims[0]['source_material_sent'] ?? '');
}
