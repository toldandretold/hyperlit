<?php

namespace App\Services\CitationReview\Support;

use App\Services\CitationPipeline\ResolutionLadderMap;

/**
 * ONE citation's journey through resolution, as an ordered list of renderable steps.
 *
 * This is the shared data model behind three surfaces: the maintainer workbench (dev labels),
 * the reader-facing review report (plain labels + GitHub links), and nothing else — both render
 * THIS, so they cannot disagree about what happened to a citation.
 *
 * Sources, in order of authority:
 * - `match_diagnostics.trace` (the WaveTracer ledger) — the real path, step by step, when the
 *   row was scanned after tracing landed (2026-09-27).
 * - PRE-ROUTED citations never enter the ladder, so they have no ladder trace BY DESIGN: a
 *   short form inherits its antecedent, legislation is counted but never searched, a
 *   non-citation is dropped at classification. Their path is inferred from the columns those
 *   routes DO write, and rendered against the map's pre-routing stations.
 * - Rows scanned BEFORE tracing carry only `match_method`; their path is a single synthesized
 *   step with `recorded: false` — rendered as "not recorded", NEVER as "did not run", because
 *   the absence is about when the row was scanned, not about what the ladder did.
 *
 * Every step's `stage` is a ResolutionLadderMap station id, and labels/code_refs come from the
 * map — the same vocabulary the published diagram uses, which is what lets a citation's path
 * light up ON that diagram.
 */
final class CitationPath
{
    /**
     * Which ladder station a legacy `match_method` implies, for rows scanned before tracing.
     * `library` is genuinely ambiguous (Wave 3 or the URL-first fallback both write it); it maps
     * to the title search, which is where the match was FOUND even when the fallback applied it.
     */
    private const METHOD_TO_STAGE = [
        'local_doi'           => 'local_doi_lookup',
        'doi'                 => 'openalex_doi_lookup',
        'library'             => 'local_library_title',
        'openalex_referenced' => 'referenced_works_pool',
        'openalex'            => 'openalex_title_search',
        'open_library'        => 'open_library_search',
        'semantic_scholar'    => 'semantic_scholar_search',
        'web_fetch'           => 'printed_url_fetch',
        'brave_search'        => 'brave_search_fallback',
    ];

    /**
     * @param array $claim a claim/citation row: is_citation, match_method, llm_metadata,
     *                     match_diagnostics (decoded), source_book_id …
     * @return array{steps: list<array<string, mixed>>, subs: array<string, list<array<string, mixed>>>, recorded: bool}
     */
    public static function build(array $claim): array
    {
        $stages = self::stagesById();

        // ── Pre-routing: journeys that END before the ladder ─────────────────
        if (($claim['is_citation'] ?? true) === false) {
            return self::single($stages, 'classify', 'not_a_citation', recorded: true);
        }

        $method = $claim['match_method'] ?? null;

        if ($method === 'short_form_antecedent') {
            return self::single($stages, 'short_form', 'inherited_antecedent', recorded: true);
        }
        if ($method === 'bibliography_pointer') {
            return self::single($stages, 'pointer', 'matched_own_bibliography', recorded: true);
        }

        $type = $claim['llm_metadata']['type'] ?? null;
        if ($method === null && in_array($type, ['legislation', 'case-law'], true)) {
            return self::single($stages, 'legal_excluded', 'excluded_by_design', recorded: true);
        }

        // ── The ladder: the trace when we have it ────────────────────────────
        $trace = $claim['match_diagnostics']['trace'] ?? null;

        if (is_array($trace) && !empty($trace['steps'])) {
            $steps = array_map(fn (array $s) => self::decorate($stages, $s, recorded: true), $trace['steps']);

            $subs = [];
            foreach ($trace['subs'] ?? [] as $subKey => $subSteps) {
                $subs[$subKey] = array_map(fn (array $s) => self::decorate($stages, $s, recorded: true), $subSteps);
            }

            return ['steps' => $steps, 'subs' => $subs, 'recorded' => true];
        }

        // ── Pre-trace rows: synthesize the one step match_method testifies to ─
        if ($method !== null) {
            $stageId = self::METHOD_TO_STAGE[$method] ?? null;
            if ($stageId !== null) {
                $step = self::decorate($stages, [
                    'stage'   => $stageId,
                    'outcome' => 'newly_resolved',
                    'method'  => $method,
                ], recorded: false);
                if (isset($claim['match_score']) && $claim['match_score'] !== null) {
                    $step['score'] = round((float) $claim['match_score'], 3);
                }

                return ['steps' => [$step], 'subs' => [], 'recorded' => false];
            }
        }

        // Unresolved, no trace: all we can honestly say is that the ladder ended empty-handed.
        return self::single($stages, 'no_match', 'no_match', recorded: false);
    }

    /**
     * The READER's version of the path: one row per reviewer question (band), narrating what
     * happened there, instead of sixteen machine steps. The workbench keeps step-level fidelity;
     * a report block repeated 135 times cannot afford it — and a reader follows a story, not a
     * ledger. Questions come from ResolutionLadderMap::bands(), the same vocabulary the
     * published map and the workbench use.
     *
     * @return array{recorded: bool, rows: list<array{band: string, question: string, kind: string, text: string, code_ref: ?string, source_url: ?string}>}
     */
    public static function summarize(array $claim): array
    {
        $path = self::build($claim);
        $questions = [];
        foreach (ResolutionLadderMap::bands() as $band) {
            $questions[$band['id']] = $band['question'];
        }

        $rows = [];
        $steps = $path['steps'];
        $first = $steps[0] ?? null;

        // ── Pre-routed journeys: one row, the citation's whole story ─────────
        $preText = match ($first['outcome'] ?? null) {
            'not_a_citation'          => 'Read as commentary or a cross-reference, not a citation of a work — nothing to identify.',
            'inherited_antecedent'    => 'A short form (an “Ibid.”-style reference) — it inherits the work from the full citation before it, and is judged against that work.',
            'matched_own_bibliography' => 'An author–date pointer into this document’s own reference list — matched there, never searched online.',
            'excluded_by_design'      => 'Legislation or case law — counted as a citation but never searched: an instrument name is not a search query.',
            default                   => null,
        };
        if ($preText !== null) {
            return ['recorded' => $path['recorded'], 'rows' => [self::row(
                'route', $questions['route'], 'routed', $preText, $first,
            )]];
        }

        // ── The ladder: what was tried, and where (if anywhere) it ended ─────
        $rows[] = self::row('route', $questions['route'], 'routed',
            'A work to identify — it entered the resolution ladder.', null);

        $resolvedStep = null;
        $tried = 0;
        $notable = [];
        foreach ($steps as $step) {
            if (in_array($step['outcome'], ['newly_resolved', 'enriched'], true)) {
                $resolvedStep = $step;
                break;
            }
            if ($step['outcome'] === 'no_match') {
                $tried++;
            }
            // Evidence a reader needs even from a failed step, phrased from its detail.
            $detail = $step['detail'] ?? [];
            if (isset($detail['web_fetch']['outcome'])) {
                $wf = $detail['web_fetch'];
                $status = isset($wf['http_status']) && $wf['http_status'] ? " (HTTP {$wf['http_status']})" : '';
                $notable[] = 'The printed URL was fetched: ' . str_replace('_', ' ', (string) $wf['outcome']) . $status . '.';
            }
            if (isset($detail['brave']['refused']) && $detail['brave']['refused'] !== []) {
                $hostRefusals = count(array_filter($detail['brave']['refused'],
                    fn ($r) => ($r['why'] ?? '') === 'host_differs_from_cited_url'));
                if ($hostRefusals > 0) {
                    $notable[] = "Web search found {$hostRefusals} look-alike page" . ($hostRefusals > 1 ? 's' : '')
                        . ' on other websites and refused ' . ($hostRefusals > 1 ? 'them' : 'it')
                        . ' — a page merely sharing the title is not the source.';
                }
            }
        }

        if ($resolvedStep !== null) {
            $score = isset($resolvedStep['score']) ? " (match score {$resolvedStep['score']})" : '';
            $via = $tried > 0 ? " after {$tried} cheaper route" . ($tried > 1 ? 's' : '') . ' found nothing' : '';
            $rows[] = self::row('ladder', $questions['ladder'], 'resolved',
                'Identified — ' . lcfirst((string) $resolvedStep['title']) . $score . $via . '.', $resolvedStep);
        } elseif (!$path['recorded']) {
            // The synthesized single step is NOT a route count — claiming the full inventory ran
            // would be stating more than the record supports.
            $rows[] = self::row('ladder', $questions['ladder'], 'nomatch',
                'Not identified. This row predates per-step tracing, so which routes ran was not '
                . 'recorded. “Not found” is a fact about our search, not proof the citation is wrong.', null);
        } else {
            // Name the inventory only when the trace shows the ladder genuinely ran its length —
            // a short trace (early termination, tiny pool) must not read as the full sweep.
            $inventory = $tried >= 12
                ? ' (identifiers, this library, three scholarly indexes, shortened titles, the printed URL, open web search)'
                : '';
            $rows[] = self::row('ladder', $questions['ladder'], 'nomatch',
                "Not identified — {$tried} route" . ($tried === 1 ? '' : 's') . " tried{$inventory}, none matched. "
                . '“Not found” is a fact about our search, not proof the citation is wrong.', null);
        }

        foreach ($notable as $text) {
            $rows[] = self::row('acq', $questions['acq'], 'evidence', $text, null);
        }

        if (!$path['recorded']) {
            $rows[] = self::row('route', 'Not recorded', 'notrecorded',
                'This citation was resolved before per-step tracing existed — the path above is '
                . 'only what its stored record testifies to, not a claim that nothing else ran.', null);
        }

        return ['recorded' => $path['recorded'], 'rows' => $rows];
    }

    private static function row(string $band, string $question, string $kind, string $text, ?array $step): array
    {
        return [
            'band'       => $band,
            'question'   => $question,
            'kind'       => $kind,
            'text'       => $text,
            'code_ref'   => $step['code_ref'] ?? null,
            'source_url' => $step['source_url'] ?? null,
        ];
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** @return array<string, array<string, mixed>> station id => map entry */
    private static function stagesById(): array
    {
        static $byId = null;
        if ($byId === null) {
            $byId = [];
            foreach (ResolutionLadderMap::allStages() as $stage) {
                $byId[$stage['id']] = $stage;
            }
        }

        return $byId;
    }

    private static function single(array $stages, string $stageId, string $outcome, bool $recorded): array
    {
        return [
            'steps'    => [self::decorate($stages, ['stage' => $stageId, 'outcome' => $outcome], $recorded)],
            'subs'     => [],
            'recorded' => $recorded,
        ];
    }

    /** Attach the map's labels and code link to a raw trace step. */
    private static function decorate(array $stages, array $step, bool $recorded): array
    {
        $stage = $stages[$step['stage']] ?? null;

        $step['recorded'] = $recorded;
        $step['label_plain'] = $stage['plain'] ?? $step['stage'];
        $step['label_dev'] = $stage['dev'] ?? $step['stage'];
        $step['title'] = $stage['title'] ?? $step['stage'];
        if ($stage !== null) {
            $step['code_ref'] = $stage['code_ref'];
            $step['source_url'] = ResolutionLadderMap::sourceUrl($stage['code_ref']);
        }

        return $step;
    }
}
