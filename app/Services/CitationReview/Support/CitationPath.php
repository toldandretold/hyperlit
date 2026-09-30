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
     * A work label longer than this is elided — the rail heading names the work, it does not
     * reproduce the citation (the full text sits above it in the "citation as printed" pane).
     */
    private const LABEL_MAX = 110;

    /**
     * @param array $claim a claim/citation row: is_citation, match_method, llm_metadata,
     *                     match_diagnostics (decoded), source_book_id …
     * @return array{steps: list<array<string, mixed>>, subs: array<string, list<array<string, mixed>>>, recorded: bool, works: array<string, array<string, mixed>>}
     */
    public static function build(array $claim): array
    {
        $path = self::buildRails($claim);
        $path['works'] = self::works($claim, array_keys($path['subs']));

        return $path;
    }

    /** The rails themselves — one for the entry, one per sub-citation that traversed the ladder. */
    private static function buildRails(array $claim): array
    {
        $stages = self::stagesById();
        $trace = $claim['match_diagnostics']['trace'] ?? null;

        // Sub rails are independent of the ENTRY's route. Pre-routing only ever describes the
        // primary work, and a legal instrument cited alongside a searchable work is the house
        // style of the corpus this serves ("… Determination 2018 (No 1) (Cth); … Social Security
        // Guide …"): returning early with no subs deleted the rail of the ONLY work that was
        // actually searched, leaving a two-work footnote looking like one excluded citation.
        $subs = [];
        foreach ((is_array($trace) ? $trace['subs'] ?? [] : []) as $subKey => $subSteps) {
            $subs[$subKey] = array_map(fn (array $s) => self::decorate($stages, $s, recorded: true), $subSteps);
        }

        // ── Pre-routing: journeys that END before the ladder ─────────────────
        if (($claim['is_citation'] ?? true) === false) {
            return self::single($stages, 'classify', 'not_a_citation', recorded: true, subs: $subs);
        }

        $method = $claim['match_method'] ?? null;

        if ($method === 'short_form_antecedent') {
            return self::single($stages, 'short_form', 'inherited_antecedent', recorded: true, subs: $subs);
        }
        if ($method === 'bibliography_pointer') {
            return self::single($stages, 'pointer', 'matched_own_bibliography', recorded: true, subs: $subs);
        }

        $type = $claim['llm_metadata']['type'] ?? null;
        if ($method === null && in_array($type, ['legislation', 'case-law'], true)) {
            return self::single($stages, 'legal_excluded', 'excluded_by_design', recorded: true, subs: $subs);
        }

        // ── The ladder: the trace when we have it ────────────────────────────
        if (is_array($trace) && !empty($trace['steps'])) {
            $steps = array_map(fn (array $s) => self::decorate($stages, $s, recorded: true), $trace['steps']);

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

                return ['steps' => [$step], 'subs' => $subs, 'recorded' => false];
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

    /**
     * WHICH WORK each rail was chasing — keyed by rail ('steps' for the entry's own rail, 'subN'
     * for each sub-citation's), so a surface can put a name on a path instead of leaving the
     * reviewer to reverse-engineer it from a Brave query buried in a step's evidence.
     *
     * A multi-work footnote ("… Determination 2018 (No 1) (Cth); … Social Security Guide …")
     * runs several independent ladders that LOOK identical — same stations, same "no match" dots
     * — and the workbench rendered the parent's rail unlabelled with the subs' rails under "the
     * path for this one". Nothing on screen said which "one". Two failures then read as one
     * failure of an unidentified thing, which is exactly the shape of confusion that makes a
     * reviewer distrust a correct result.
     *
     * Keyed off RAW `sub_citations`, never SourceTypeClassifier::works(): that accessor drops
     * subs the scan already MATCHED (right for a not-found assessment, wrong here — a matched
     * sub still ran a ladder and still owns a rail), and its indices would no longer line up
     * with the 1-based `subN` keys the resolver mints.
     *
     * @param  list<string> $railKeys the sub rails the trace actually recorded
     * @return array<string, array<string, mixed>>
     */
    private static function works(array $claim, array $railKeys): array
    {
        $meta = $claim['llm_metadata'] ?? null;
        if (!is_array($meta) || $meta === []) {
            return [];
        }

        $subs = is_array($meta['sub_citations'] ?? null) ? $meta['sub_citations'] : [];

        // A work SPLIT OUT of a multi-work citation by the review's fan-out carries its siblings'
        // count but not their metadata — it is one work on its own row, and its rail is its own.
        if ($subs === [] && !empty($claim['cited_work_total'])) {
            return ['steps' => self::work(
                $meta,
                (int) ($claim['cited_work_position'] ?? 1),
                (int) $claim['cited_work_total'],
                searched: true,
            )];
        }

        if ($subs === []) {
            return []; // single-work entry: the rail can only be about the one work
        }

        $total = 1 + count($subs);
        $works = ['steps' => self::work($meta, 1, $total, searched: true)];

        foreach ($subs as $i => $sub) {
            if (!is_array($sub)) {
                continue;
            }
            $key = 'sub' . ($i + 1);
            // Pool expansion skips a title-less sub outright, so it has no rail and never will —
            // report that as its own outcome rather than letting the work vanish from the list.
            $titleless = empty($sub['title']);
            // Tri-state on purpose. A title-less sub definitively never ran (pool expansion
            // skips it); a rail proves one did. A titled sub with NO rail is genuinely unknown —
            // the row may predate tracing, or a resolving PARENT may have retired its subs
            // (removeRelatedPoolEntries) — and "unknown" must not be rendered as "never ran".
            $searched = $titleless ? false : (in_array($key, $railKeys, true) ? true : null);
            $works[$key] = self::work(
                $sub,
                $i + 2,
                $total,
                searched: $searched,
                skipped: $titleless ? 'No title was extracted for this work, so it never entered the resolver.' : null,
                status: $sub['resolution']['status'] ?? null,
            );
        }

        return $works;
    }

    /** One work, as a rail heading: who/when/what, plus whether a ladder ever ran for it. */
    private static function work(
        array $meta,
        int $position,
        int $total,
        ?bool $searched,
        ?string $skipped = null,
        ?string $status = null,
    ): array {
        $authors = $meta['authors'] ?? null;
        if (is_string($authors)) {
            $authors = [$authors];
        }
        $author = is_array($authors) ? (string) ($authors[0] ?? '') : '';
        if (is_array($authors) && count($authors) > 1) {
            $author .= ' et al.';
        }

        $title = trim((string) ($meta['title'] ?? ''));
        $year  = $meta['year'] ?? null;

        $label = $title !== '' ? '“' . $title . '”' : '(no title extracted)';
        if ($author !== '') {
            $label = $author . ($year ? " ({$year})" : '') . ' ' . $label;
        } elseif ($year) {
            $label .= " ({$year})";
        }
        if (mb_strlen($label) > self::LABEL_MAX) {
            $label = mb_substr($label, 0, self::LABEL_MAX - 1) . '…';
        }

        return [
            'position' => $position,
            'total'    => $total,
            'label'    => $label,
            'title'    => $title !== '' ? $title : null,
            'author'   => $author !== '' ? $author : null,
            'year'     => $year !== null && $year !== '' ? (string) $year : null,
            'type'     => $meta['type'] ?? null,
            'searched' => $searched,
            'skipped'  => $skipped,
            'status'   => $status,
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

    private static function single(
        array $stages,
        string $stageId,
        string $outcome,
        bool $recorded,
        array $subs = [],
    ): array {
        return [
            'steps'    => [self::decorate($stages, ['stage' => $stageId, 'outcome' => $outcome], $recorded)],
            'subs'     => $subs,
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
