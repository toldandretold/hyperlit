<?php

/**
 * The per-citation trace is STRUCTURAL — recorded by the runner around every wave, so a wave
 * that does not trace is unrepresentable. What this file pins is the derivation logic, because
 * the tracer REPORTS nothing: it diffs context state around run() and every outcome word a
 * reader eventually sees ("resolved here", "nothing matched", "never reached", "skipped
 * because…") is computed from that diff. Get the diff wrong and the trace lies politely.
 *
 * Driven through fake waves rather than the real ladder — the real waves' behaviour is pinned
 * by the characterisation golden; what is under test here is only the tracer's bookkeeping.
 */

use App\Services\CitationPipeline\Resolution\ResolutionContext;
use App\Services\CitationPipeline\Resolution\ResolutionHost;
use App\Services\CitationPipeline\Resolution\ResolutionWave;
use App\Services\CitationPipeline\Resolution\WaveTracer;
use App\Services\OpenAlexService;

function tracerCtx(array $poolIds): ResolutionContext
{
    $ctx = new ResolutionContext(
        Mockery::mock(ResolutionHost::class),
        Mockery::mock(OpenAlexService::class),
        null,
    );
    foreach ($poolIds as $id) {
        $ctx->pool[$id] = ['referenceId' => $id];
    }

    return $ctx;
}

function fakeWave(string $id, callable $run, bool $shouldRun = true, string $acceptGate = 'Some bar.'): ResolutionWave
{
    return new class($id, $run, $shouldRun, $acceptGate) implements ResolutionWave {
        public function __construct(
            private string $waveId,
            private $runFn,
            private bool $should,
            private string $accept,
        ) {
        }

        public function id(): string
        {
            return $this->waveId;
        }

        public function title(): string
        {
            return $this->waveId;
        }

        public function plain(): string
        {
            return 'plain';
        }

        public function dev(): string
        {
            return 'dev';
        }

        public function entryGate(): string
        {
            return 'An entry gate for ' . $this->waveId . '.';
        }

        public function acceptGate(): string
        {
            return $this->accept;
        }

        public function logMarker(): ?string
        {
            return null;
        }

        public function edges(): array
        {
            return [];
        }

        public function shouldRun(ResolutionContext $ctx): bool
        {
            return $this->should;
        }

        public function run(ResolutionContext $ctx): void
        {
            ($this->runFn)($ctx);
        }
    };
}

test('a citation resolved by a wave gets that wave\'s step with method and score from the result row', function () {
    $ctx = tracerCtx(['c1', 'c2']);

    (new WaveTracer($ctx))->runTraced(fakeWave('open_library_search', function (ResolutionContext $ctx) {
        $ctx->recordResult([
            'referenceId'      => 'c1',
            'status'           => 'newly_resolved',
            'match_method'     => 'open_library',
            'similarity_score' => 0.8125,
        ]);
        unset($ctx->pool['c1']);
    }));

    expect($ctx->trace['c1'])->toBe([[
        'stage'   => 'open_library_search',
        'outcome' => 'newly_resolved',
        'method'  => 'open_library',
        'score'   => 0.813,
    ]])
        ->and($ctx->trace['c2'])->toBe([['stage' => 'open_library_search', 'outcome' => 'no_match']]);
});

test('"ran and found nothing" and "never reached" are different traces', function () {
    // THE distinction the whole ledger exists for. c1 resolves in wave one, so wave two never
    // sees it — its trace must STOP, not report a second failure.
    $ctx = tracerCtx(['c1', 'c2']);
    $tracer = new WaveTracer($ctx);

    $tracer->runTraced(fakeWave('local_library_title', function (ResolutionContext $ctx) {
        $ctx->recordResult(['referenceId' => 'c1', 'status' => 'newly_resolved', 'match_method' => 'library']);
        unset($ctx->pool['c1']);
    }));
    $tracer->runTraced(fakeWave('brave_search_fallback', fn () => null));

    expect(array_column($ctx->trace['c1'], 'stage'))->toBe(['local_library_title'])
        ->and(array_column($ctx->trace['c2'], 'stage'))->toBe(['local_library_title', 'brave_search_fallback'])
        ->and($ctx->trace['c2'][1]['outcome'])->toBe('no_match');
});

test('a skipped wave records WHY for every citation still in the pool', function () {
    // "Brave was never asked because no API key is configured" used to be invisible.
    $ctx = tracerCtx(['c1']);

    (new WaveTracer($ctx))->runTraced(fakeWave('brave_search_fallback', fn () => null, shouldRun: false));

    expect($ctx->trace['c1'])->toBe([[
        'stage'   => 'brave_search_fallback',
        'outcome' => 'skipped',
        'reason'  => 'An entry gate for brave_search_fallback.',
    ]]);
});

test('a sub-citation retired by its parent\'s resolution reads retired, not failed', function () {
    $ctx = tracerCtx(['p1', 'p1::sub1']);

    (new WaveTracer($ctx))->runTraced(fakeWave('openalex_doi_lookup', function (ResolutionContext $ctx) {
        $ctx->recordResult(['referenceId' => 'p1', 'status' => 'newly_resolved', 'match_method' => 'doi']);
        // removeRelatedPoolEntries retires the whole family
        unset($ctx->pool['p1'], $ctx->pool['p1::sub1']);
    }));

    expect($ctx->trace['p1::sub1'][0]['outcome'])->toBe('retired_with_relative');
});

test('a routing wave\'s pass-through is routed, never no_match', function () {
    // DOI extraction matches nothing by design; fourteen "no_match" steps on every citation
    // would read as fourteen failures.
    $ctx = tracerCtx(['c1']);

    (new WaveTracer($ctx))->runTraced(
        fakeWave('doi_from_text', fn () => null, acceptGate: 'None — extraction only.')
    );

    expect($ctx->trace['c1'][0]['outcome'])->toBe('routed');
});

test('what a wave writes into waveResults rides the step as detail', function () {
    // The tracer knows no wave's schema — it diffs waveResults per citation, so the Brave
    // decision record and the web_fetch outcome reach the trace without the tracer naming them.
    $ctx = tracerCtx(['c1', 'c2']);
    $ctx->waveResults['c1']['openalex'] = 'best_score:0.2';

    (new WaveTracer($ctx))->runTraced(fakeWave('brave_search_fallback', function (ResolutionContext $ctx) {
        $ctx->waveResults['c1']['brave'] = ['query' => '"T" A 2020', 'chosen' => null];
    }));

    expect($ctx->trace['c1'][0]['detail'])->toBe(['brave' => ['query' => '"T" A 2020', 'chosen' => null]])
        ->and($ctx->trace['c2'][0])->not->toHaveKey('detail');
});

test('every stage id a trace can carry is on the published map', function () {
    // The trace is persisted and rendered against ResolutionLadderMap's vocabulary; a wave id
    // absent from the map would render as an unexplained step in a reader's report.
    $mapIds = \App\Services\CitationPipeline\ResolutionLadderMap::stageIds();

    foreach (\App\Services\CitationPipeline\Resolution\ResolutionLadder::waves() as $wave) {
        expect(in_array($wave->id(), $mapIds, true))
            ->toBeTrue("wave '{$wave->id()}' is not a stage on ResolutionLadderMap");
    }
});
