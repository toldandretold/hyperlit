<?php

namespace App\Services\CitationPipeline\Resolution;

use App\Services\OpenAlexService;

/**
 * The state the resolution waves pass between them.
 *
 * `CitationScanBibliographyJob::handle()` is 1,596 lines with 122 local variables, and moving a
 * wave into its own class means naming which of those the wave ladder actually CARRIES. Measured:
 * 48 names cross a wave boundary, but most are loop temporaries reusing a name (`candidate`,
 * `score`, `title`, `item`, `parts`). What genuinely accumulates is the handful below — the pool
 * being whittled down, the results being appended, three counters, and the diagnostics the later
 * waves read back.
 *
 * `$pool` is the spine: every wave removes what it resolved, so a wave's input is "whatever nobody
 * has claimed yet". It is a plain public array rather than an encapsulated collection on purpose —
 * the existing code mutates it by reference in a dozen places, and making that ceremonial before
 * the waves have moved would be two refactors tangled into one, which is how a characterisation
 * diff stops being readable.
 *
 * @see LadderCassette — nothing in here may be changed without `citation:ladder:golden --verify`
 *      going green, because a wave that resolves a citation to a DIFFERENT source fails silently.
 */
class ResolutionContext
{
    /** @var array<string, array<string, mixed>> refId => pool item; waves REMOVE what they resolve */
    public array $pool = [];

    /** @var list<array<string, mixed>> per-citation outcome records, appended by every wave */
    public array $results = [];

    public int $newlyResolved = 0;
    public int $enrichedExisting = 0;
    public int $failedToResolve = 0;

    /** @var array<string, mixed> refId => best sub-threshold candidate seen across ALL waves */
    public array $nearMisses = [];

    /** @var array<string, mixed> refId => per-wave outcome, for diagnostics */
    public array $waveResults = [];

    /**
     * refId => source => candidates, kept so the Phase B retries can RE-SCORE what an earlier wave
     * already fetched instead of paying for the same search twice.
     *
     * @var array<string, array<string, mixed>>
     */
    public array $storedCandidates = [];

    /** @var array<string, string> refId => DOI still unresolved; 2a fills it, 2b drains it */
    public array $doisToLookup = [];

    /**
     * The per-citation trace: refId => ordered steps, written by WaveTracer around every wave
     * and persisted under match_diagnostics.trace. The reason "ran and found nothing" is now
     * distinguishable from "never reached".
     *
     * @var array<string, list<array<string, mixed>>>
     */
    public array $trace = [];

    public function __construct(
        public readonly ResolutionHost $host,
        public readonly OpenAlexService $openAlex,
        public readonly mixed $db,
    ) {
    }

    /**
     * Record a wave's outcome for one citation and move the counters.
     *
     * Every wave did this by hand, and the three counters drifting out of step with `$results` is
     * a bug nothing would catch — the scan report would simply understate what happened. One place
     * to get it right.
     */
    public function recordResult(array $result): void
    {
        $this->results[] = $result;

        match ($result['status'] ?? null) {
            'newly_resolved' => $this->newlyResolved++,
            'enriched'       => $this->enrichedExisting++,
            default          => $this->failedToResolve++,
        };
    }
}
