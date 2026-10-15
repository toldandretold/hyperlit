<?php

/**
 * SINGLE-CITATION REVIEW (--only mode): the service reviews ONE referenceId
 * without disturbing the rest of the book.
 *
 * Contract pinned here:
 *  - nodes are parsed WHOLE-BOOK first, then filtered to those carrying the
 *    target refId — and the kept nodes stay INTACT (every citation's markers
 *    and reference_ids present), so extraction grouping and scopeToOwnSegment
 *    behave exactly as in a full run;
 *  - claims are filtered to the target refId after extraction, BEFORE
 *    expandMultiWorkClaims (which then fans out only the target's ::subN rows);
 *  - VerificationHighlighter is NEVER called — createVerificationHighlights
 *    opens with a whole-book deleteHighlightsByCreator('AIreview:') sweep that
 *    would destroy every other citation's highlights (the data-loss regression
 *    this file exists to prevent);
 *  - CitationCoverage is skipped (its denominator is whole-book) and the stats
 *    say so: partial=true, only_reference_id set, coverage keys null.
 */

use App\Services\CitationReview\Import\ReportSubBookImporter;
use App\Services\CitationReview\Phases\CitationParser;
use App\Services\CitationReview\Phases\ClaimVerifier;
use App\Services\CitationReview\Phases\MetadataEnricher;
use App\Services\CitationReview\Phases\PassageSearcher;
use App\Services\CitationReview\Phases\TruthClaimExtractor;
use App\Services\CitationReview\Phases\VerificationHighlighter;
use App\Services\CitationReview\Report\ReportBuilder;
use App\Services\CitationReview\Support\CitationCoverage;
use App\Services\CitationReviewService;
use App\Services\LlmService;

function onlyNode(string $nodeId, array $refIds): array
{
    return ['node_id' => $nodeId, 'reference_ids' => $refIds, 'content' => "node {$nodeId}"];
}

/**
 * Build the service with mocked phases. Returns [service, mocks] where mocks
 * is a keyed array for per-test expectations.
 */
function onlyService(array $nodes, array $extracted): array
{
    $mocks = [
        'parser' => Mockery::mock(CitationParser::class),
        'enricher' => Mockery::mock(MetadataEnricher::class),
        'extractor' => Mockery::mock(TruthClaimExtractor::class),
        'searcher' => Mockery::mock(PassageSearcher::class),
        'verifier' => Mockery::mock(ClaimVerifier::class),
        'highlighter' => Mockery::mock(VerificationHighlighter::class),
        'coverage' => Mockery::mock(CitationCoverage::class),
    ];

    $mocks['parser']->shouldReceive('parseCitationNodes')->andReturn($nodes)->byDefault();
    $mocks['enricher']->shouldReceive('enrichCitationMetadata')
        ->andReturnUsing(function (array $gotNodes) {
            $meta = [];
            foreach ($gotNodes as $n) {
                foreach ($n['reference_ids'] as $r) {
                    $meta[$r] = ['verified' => false, 'has_source_content' => false];
                }
            }
            return $meta;
        })->byDefault();
    $mocks['extractor']->shouldReceive('extractTruthClaims')->andReturn($extracted)->byDefault();

    $service = new CitationReviewService(
        Mockery::mock(LlmService::class)->shouldIgnoreMissing(),
        $mocks['parser'],
        $mocks['enricher'],
        $mocks['extractor'],
        $mocks['searcher'],
        $mocks['verifier'],
        $mocks['highlighter'],
        Mockery::mock(ReportBuilder::class)->shouldIgnoreMissing(),
        Mockery::mock(ReportSubBookImporter::class)->shouldIgnoreMissing(),
        $mocks['coverage'],
    );

    return [$service, $mocks];
}

afterEach(fn () => Mockery::close());

it('filters nodes to the target refId but keeps kept nodes whole', function () {
    $nodes = [
        onlyNode('n1', ['target', 'other1']),
        onlyNode('n2', ['other2']),
        onlyNode('n3', ['target']),
    ];
    $claims = [
        ['referenceId' => 'target', 'truth_claim' => 'c1'],
        ['referenceId' => 'other1', 'truth_claim' => 'c2'],
    ];
    [$service, $mocks] = onlyService($nodes, $claims);

    $seenByEnricher = null;
    $mocks['enricher']->shouldReceive('enrichCitationMetadata')
        ->andReturnUsing(function (array $gotNodes) use (&$seenByEnricher) {
            $seenByEnricher = $gotNodes;
            return [];
        });

    $mocks['extractor']->shouldReceive('expandMultiWorkClaims')
        ->andReturnUsing(fn (array $c) => $c);
    $mocks['searcher']->shouldReceive('searchSourcePassages');
    $mocks['verifier']->shouldReceive('verifyClaims');
    $mocks['coverage']->shouldReceive('assess')->never();
    $mocks['highlighter']->shouldReceive('createVerificationHighlights')->never();
    $mocks['highlighter']->shouldReceive('createUnmatchedCitationHighlights')->never();

    $result = $service->review('book_x', null, 'target');

    // n2 dropped; n1 kept INTACT with other1 still aboard.
    expect(array_column($seenByEnricher, 'node_id'))->toBe(['n1', 'n3'])
        ->and($seenByEnricher[0]['reference_ids'])->toBe(['target', 'other1']);

    // other1's claim (extracted from the shared node) filtered out.
    expect(array_column($result['claims'], 'referenceId'))->toBe(['target']);
});

it('filters claims BEFORE multi-work expansion and never touches highlights', function () {
    $nodes = [onlyNode('n1', ['target', 'other1'])];
    $claims = [
        ['referenceId' => 'target', 'truth_claim' => 'c1'],
        ['referenceId' => 'other1', 'truth_claim' => 'c2'],
    ];
    [$service, $mocks] = onlyService($nodes, $claims);

    $expandedInput = null;
    $mocks['extractor']->shouldReceive('expandMultiWorkClaims')
        ->andReturnUsing(function (array $c) use (&$expandedInput) {
            $expandedInput = $c;
            // The expansion fans the target out into its ::subN rows.
            return array_merge($c, [['referenceId' => 'target::sub1', 'truth_claim' => 'c1']]);
        });
    $mocks['searcher']->shouldReceive('searchSourcePassages');
    $mocks['verifier']->shouldReceive('verifyClaims');
    $mocks['coverage']->shouldReceive('assess')->never();
    $mocks['highlighter']->shouldReceive('createVerificationHighlights')->never();
    $mocks['highlighter']->shouldReceive('createUnmatchedCitationHighlights')->never();

    $result = $service->review('book_x', null, 'target');

    expect(array_column($expandedInput, 'referenceId'))->toBe(['target'])
        ->and(array_column($result['claims'], 'referenceId'))->toBe(['target', 'target::sub1'])
        ->and($result['stats']['partial'])->toBeTrue()
        ->and($result['stats']['only_reference_id'])->toBe('target')
        ->and($result['stats']['citation_instances'])->toBeNull()
        ->and($result['stats']['coverage_rate'])->toBeNull();
});

it('returns empty with partial stats when no node carries the refId', function () {
    [$service, $mocks] = onlyService([onlyNode('n1', ['other1'])], []);

    $mocks['searcher']->shouldReceive('searchSourcePassages')->never();
    $mocks['verifier']->shouldReceive('verifyClaims')->never();
    $mocks['highlighter']->shouldReceive('createVerificationHighlights')->never();

    $result = $service->review('book_x', null, 'target');

    expect($result['claims'])->toBe([])
        ->and($result['stats']['partial'])->toBeTrue()
        ->and($result['stats']['only_reference_id'])->toBe('target');
});

it('runs the whole-book path untouched when only is not given', function () {
    $nodes = [onlyNode('n1', ['a'])];
    $claims = [['referenceId' => 'a', 'truth_claim' => 'c1']];
    [$service, $mocks] = onlyService($nodes, $claims);

    $mocks['extractor']->shouldReceive('expandMultiWorkClaims')->andReturnUsing(fn (array $c) => $c);
    $mocks['searcher']->shouldReceive('searchSourcePassages');
    $mocks['verifier']->shouldReceive('verifyClaims');
    $mocks['coverage']->shouldReceive('assess')->once()->andReturn([
        'instances' => 1, 'matched' => 1, 'unmatched' => 0, 'unmatched_refs' => 0, 'rate' => 1.0, 'details' => [],
    ]);
    $mocks['highlighter']->shouldReceive('createVerificationHighlights')->once()->andReturn(1);
    $mocks['highlighter']->shouldReceive('createUnmatchedCitationHighlights')->once()->andReturn(0);

    $result = $service->review('book_x');

    expect($result['stats'])->not->toHaveKey('partial')
        ->and($result['stats']['coverage_rate'])->toBe(1.0);
});
