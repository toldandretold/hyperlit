<?php

namespace App\Services\CitationStudy;

use App\Services\CitationReview\Support\ShortFormReference;
use App\Services\CitationReview\Support\SourceWorkMismatch;
use Illuminate\Support\Facades\DB;

/**
 * Read-side of the /maintainer/study workbench: composes everything the human
 * reviewer needs per citation into one payload — the AI's claim + verdict, the
 * bound ground-truth entry, the conversion-triage evidence ("did OUR OCR
 * mangle this citation?"), and any prior human adjudication.
 *
 * All file-based (state.json → claims JSON → ground_truth.json → triage CSV →
 * adjudications JSON); nothing here writes.
 */
class WorkbenchData
{
    /** Verdicts the workbench filters to by default — the ones worth a human's time. */
    public const FLAGGED_VERDICTS = ['rejected', 'unlikely', 'source_not_found', 'insufficient'];

    public function __construct(
        private readonly StudyRunner $runner,
        private readonly ClaimsJoiner $joiner,
        private readonly AdjudicationStore $adjudications,
    ) {}

    /** Corpus overview: one row per book with run status + review progress. */
    public function corpusSummary(CorpusManifest $manifest): array
    {
        $state = $this->runner->loadState($manifest);
        $books = [];
        foreach ($manifest->books() as $book) {
            $slug = $book['slug'];
            $bookState = $state['books'][$slug] ?? null;
            $counts = ['total' => 0, 'flagged' => 0, 'adjudicated' => 0];
            if (($bookState['status'] ?? null) === 'completed' && is_file($bookState['claims_file'] ?? '')) {
                $claims = json_decode((string) file_get_contents($bookState['claims_file']), true) ?: [];
                $counts['total'] = count($claims);
                foreach ($claims as $claim) {
                    if (in_array($this->verdict($claim), self::FLAGGED_VERDICTS, true)) {
                        $counts['flagged']++;
                    }
                }
                $counts['adjudicated'] = count($this->adjudications->load($manifest, $book)['adjudications']);
            }
            $books[] = [
                'slug' => $slug,
                'arm' => $book['arm'],
                // The PATHWAY is what distinguishes rows in a multi-pathway corpus: the same work
                // appears four times with an identical title, and every one of them is 'control',
                // so the arm alone leaves them indistinguishable in the list.
                'pathway' => $book['pathway'] ?? null,
                'title' => $book['provenance']['title'] ?? $slug,
                'run_id' => $bookState['run_id'] ?? null,
                'run_status' => $bookState['status'] ?? 'not_run',
                'counts' => $counts,
            ];
        }
        return [
            'corpus' => $manifest->corpus,
            'frozen' => $manifest->isFrozen(),
            'books' => $books,
        ];
    }

    /**
     * Full workbench payload for one book. Returns run_status != 'completed'
     * with no claims (never a 500) when the study hasn't run it yet.
     */
    public function bookPayload(CorpusManifest $manifest, string $slug): array
    {
        $book = $manifest->book($slug);
        $state = $this->runner->loadState($manifest);
        $bookState = $state['books'][$slug] ?? null;

        $base = [
            'corpus' => $manifest->corpus,
            'frozen' => $manifest->isFrozen(),
            'slug' => $slug,
            'arm' => $book['arm'],
            'pathway' => $manifest->pathwayFor($book),
            // How this corpus copy was BUILT. 'raw-file' = the real source
            // document (what a user would import). 'exported-from-nodes' =
            // the legacy round-trip: an already-converted book exported to
            // plain text and re-imported, which DESTROYS the original
            // citation anchors and re-derives them — the reviewer must know,
            // because a mislink in such a book may be an artifact of that
            // round-trip rather than a defect the product would produce.
            'source_markdown' => $book['provenance']['source_markdown'] ?? null,
            'source_file' => $book['source_file'] ?? null,
            'provenance' => $book['provenance'] ?? [],
            'source_book_id' => $book['provenance']['source_book_id'] ?? null,
            'run_id' => $bookState['run_id'] ?? null,
            'run_status' => $bookState['status'] ?? 'not_run',
            'claims' => [],
            'counts' => ['total' => 0, 'flagged' => 0, 'adjudicated' => 0],
        ];

        $claimsFile = $bookState['claims_file'] ?? null;
        if (($bookState['status'] ?? null) !== 'completed' || !$claimsFile || !is_file($claimsFile)) {
            return $base;
        }
        $claims = json_decode((string) file_get_contents($claimsFile), true);
        if (!is_array($claims)) {
            return $base;
        }

        $groundTruth = is_file($manifest->groundTruthPath($book))
            ? $manifest->loadGroundTruth($book)
            : ['entries' => []];
        [$bibLevel, $snippetLevel] = ClaimsJoiner::indexGroundTruth($groundTruth);
        $triage = $this->loadTriage($manifest, $slug);
        $adjudications = $this->adjudications->load($manifest, $book)['adjudications'];
        $anchorYears = $this->anchorYearsByReference($manifest->bookIdFor($slug));
        $entryYears = $this->entryYearsByReference($manifest->bookIdFor($slug));
        $storedText = $this->storedSourceText($claims);

        $rows = [];
        $flagged = 0;
        foreach ($claims as $claim) {
            $ref = $claim['referenceId'] ?? null;
            $gt = $this->joiner->resolveLabel($claim, $ref, $bibLevel, $snippetLevel);
            $verdict = $this->verdict($claim);
            if (in_array($verdict, self::FLAGGED_VERDICTS, true)) {
                $flagged++;
            }
            $key = $gt['gt_id'] ?? ('ref:' . ($ref ?? 'unknown'));
            $rows[] = [
                'key' => $key,
                'referenceId' => $ref,
                'node_id' => $claim['node_id'] ?? null,
                'citation_row' => $claim['citation_row'] ?? null,
                'verdict' => $verdict,
                'truth_claim' => $claim['truth_claim'] ?? null,
                'contextualised_claim' => $claim['contextualised_claim'] ?? null,
                // WHERE the claim text came from. A claim the model wrote reads the same as one
                // we scoped back to its own citation ('span_scoped') or rescued from our own
                // span ('span_fallback'/'span_backfill'), and the difference changes how a weak
                // verdict should be read — see TruthClaimExtractor::scopeToOwnSegment.
                'claim_source' => $claim['claim_source'] ?? null,
                'bib_citation' => $claim['bib_citation'] ?? null,
                // What a bare "Ibid." actually points at. The scan SUBSTITUTES a linked short
                // form's metadata with its antecedent's, so the referenced work is sitting on
                // the claim — but the reviewer only ever saw "Ibid." and a "No source found"
                // pane, with the inheritance visible nowhere except the host in Check link.
                // Rendered by the same helper as the report, because the console and the
                // report disagreeing about what a citation refers to is worse than neither.
                'short_form_of' => ShortFormReference::describe($claim),
                'llm_metadata' => $claim['llm_metadata'] ?? null,
                'llm_verdict' => $claim['llm_verdict'] ?? null,
                'source' => [
                    'found' => !empty($claim['source_book_id']),
                    'book_id' => $claim['source_book_id'] ?? null,
                    'title' => $claim['source_title'] ?? null,
                    'author' => $claim['source_author'] ?? null,
                    'year' => $claim['source_year'] ?? null,
                    'url' => $claim['source_url'] ?? null,
                    'doi' => $claim['source_doi'] ?? null,
                    'match_method' => $claim['match_method'] ?? null,
                    'match_score' => $claim['match_score'] ?? null,
                    // Identity certain, YEAR divergent (edition/reprint, or the author's details
                    // are wrong). Surfaced so the reviewer sees "printed 1964, record 2016" as a
                    // fact about the citation instead of a silently-resolved match.
                    'edition_mismatch' => $claim['match_diagnostics']['edition_mismatch'] ?? null,
                    // Chapter-in-edited-volume accepted past a divergent year because the record's
                    // container agrees with the printed volume title (see containerCorroborationTier).
                    'container_corroborated' => $claim['match_diagnostics']['container_corroborated'] ?? null,
                    // The source we verified against is NOT the work this claim is about, with
                    // the cause (multi-work footnote / wrong identifier / title-search reach).
                    // The verdict is void, not negative. DERIVED from the claim rather than read
                    // from a stored flag, so it shows on every existing run without a re-scan —
                    // by the same helper the report uses, because the console and the report
                    // disagreeing about whether a citation is suspect is worse than neither.
                    'work_mismatch' => SourceWorkMismatch::forClaim($claim),
                    'verification_tier' => $claim['verification_tier'] ?? null,
                    'evidence_type' => $claim['evidence_type'] ?? null,
                    'passages' => $claim['source_passages'] ?? [],
                    // What the resolver actually managed to read, and why it
                    // failed when it did. Before this the reviewer had to click
                    // "Check link" by hand to tell a rotted URL from a paywall
                    // from our own extraction giving up — the run recorded only
                    // an absence.
                    'content_grade' => $claim['source_completeness'] ?? null,
                    'content_grade_note' => $claim['source_completeness_reason'] ?? null,
                    'web_status' => $claim['web_status'] ?? null,
                    'fetch_outcome' => $this->fetchOutcome($claim),
                    // How much text our extraction actually KEPT from this source. The verifier
                    // only ever sees a few passages, so without this a 400-char navigation rail
                    // and a whole article look the same from here — and "the claim isn't
                    // supported" reads as a verdict about the citation when it is a verdict
                    // about our scraper. Null means we never looked (no source book).
                    'stored' => $storedText[$claim['source_book_id'] ?? ''] ?? null,
                ],
                'source_material_sent' => $claim['source_material_sent'] ?? null,
                'gt' => $gt === null ? null : [
                    'gt_id' => $gt['gt_id'],
                    'label' => $gt['label'],
                    'footnote_marker' => $gt['footnote_marker'] ?? null,
                    'corruption_meta' => $gt['corruption_meta'] ?? null,
                    // Evidence that has already been APPLIED into ground truth —
                    // distinct from the adjudication's own copy below, which is
                    // the editable one. Shown so a reviewer can see that their
                    // quotes made it into the published artifact.
                    'evidence' => $gt['evidence'] ?? null,
                    'evidence_locator' => $gt['evidence_locator'] ?? null,
                ],
                'triage' => $gt !== null ? ($triage[$gt['gt_id']] ?? null) : null,
                'adjudication' => $adjudications[$key] ?? null,
                'anchor_warning' => $this->anchorWarning($ref, $anchorYears, $entryYears, $claim),
            ];
        }

        $base['claims'] = $rows;
        $base['counts'] = [
            'total' => count($rows),
            'flagged' => $flagged,
            'adjudicated' => count($adjudications),
        ];
        return $base;
    }

    /**
     * How much text is stored for each resolved source, in ONE query.
     *
     * Per-claim lookups would be ~260 round trips on a full run, so the whole run's source books
     * are collected first and counted in a single grouped query. A source that resolved but
     * stored nothing comes back as zeros rather than absent — "we found the work and read none
     * of it" is a finding, not missing data.
     *
     * @param  list<array<string, mixed>>  $claims
     * @return array<string, array{nodes: int, chars: int}>
     */
    private function storedSourceText(array $claims): array
    {
        $books = array_values(array_unique(array_filter(
            array_map(static fn ($c) => $c['source_book_id'] ?? null, $claims)
        )));
        if ($books === []) {
            return [];
        }
        $out = array_fill_keys($books, ['nodes' => 0, 'chars' => 0]);
        try {
            $rows = DB::connection('pgsql_admin')->table('nodes')
                ->whereIn('book', $books)
                ->groupBy('book')
                ->selectRaw('book, COUNT(*) AS n, COALESCE(SUM(LENGTH("plainText")), 0) AS c')
                ->get();
        } catch (\Throwable) {
            return [];
        }
        foreach ($rows as $row) {
            $out[$row->book] = ['nodes' => (int) $row->n, 'chars' => (int) $row->c];
        }
        return $out;
    }

    /**
     * The YEARS displayed by in-text anchors, keyed "{node_id}|{referenceId}".
     * `(Singh, 2025)` rendered as `<a href="#singh2024b">2025</a>` displays
     * 2025 while targeting a 2024 entry — the shape of a mislinked citation.
     *
     * Keyed per NODE, not per reference: a work cited several times can be
     * linked correctly in one paragraph and wrongly in another (chacko's
     * savera2024 carries a 2022 anchor and a 2024 one), so a
     * reference-wide check lets the good anchor mask the bad one. The claim
     * being reviewed belongs to ONE node — that is the anchor to judge.
     *
     * Attribute order is NOT fixed (the live paste-imported books write
     * `href` first, re-converted study copies write `class` first), so the
     * pattern must accept either.
     *
     * @return array<string, string[]> "{node_id}|{referenceId}" => displayed years
     */
    private function anchorYearsByReference(string $bookId): array
    {
        $out = [];
        try {
            $rows = DB::connection('pgsql_admin')->table('nodes')
                ->where('book', $bookId)
                ->where('content', 'LIKE', '%in-text-citation%')
                ->get(['node_id', 'content']);
        } catch (\Throwable) {
            return [];
        }
        foreach ($rows as $row) {
            preg_match_all(
                '~<a[^>]*(?:href="#([^"]+)"[^>]*class="[^"]*in-text-citation|class="[^"]*in-text-citation[^"]*"[^>]*href="#([^"]+)")[^>]*>([^<]*)</a>~i',
                (string) $row->content,
                $matches,
                PREG_SET_ORDER
            );
            foreach ($matches as $m) {
                $target = $m[1] !== '' ? $m[1] : $m[2];
                if (preg_match('/(?:19|20)\d{2}/', $m[3], $year)) {
                    $out["{$row->node_id}|{$target}"][] = $year[0];
                }
            }
        }
        foreach ($out as $key => $years) {
            $out[$key] = array_values(array_unique($years));
        }
        return $out;
    }

    /**
     * The year each bibliography ENTRY actually carries, from the pipeline's
     * own extracted metadata (llm_metadata.year), falling back to the digits
     * in its referenceId key.
     *
     * @return array<string, string>
     */
    private function entryYearsByReference(string $bookId): array
    {
        $out = [];
        try {
            $rows = DB::connection('pgsql_admin')->table('bibliography')
                ->where('book', $bookId)
                ->get(['referenceId', 'llm_metadata']);
        } catch (\Throwable) {
            return [];
        }
        foreach ($rows as $row) {
            $meta = json_decode((string) ($row->llm_metadata ?? ''), true);
            $year = is_array($meta) && !empty($meta['year']) ? (string) $meta['year'] : null;
            if ($year === null && preg_match('/(?:19|20)\d{2}/', (string) $row->referenceId, $m)) {
                $year = $m[0];
            }
            if ($year !== null) {
                $out[$row->referenceId] = $year;
            }
        }
        return $out;
    }

    /**
     * One line saying what the resolver got from the citation's URL — so the
     * human reviewer can separate "this reference is bogus" from "our resolver
     * could not read a live page", which is the distinction that decides
     * whether a flagged claim is a `correct_flag` or a `resolver_gap`.
     *
     * Reads the outcome the scan recorded in match_diagnostics. Null for
     * references that resolved, or ones scanned before outcomes were recorded.
     *
     * @param  array<string, mixed>  $claim
     */
    private function fetchOutcome(array $claim): ?array
    {
        // The scan stores the near-miss envelope, so the outcome sits at
        // diagnostics.wave_results.web_fetch (see CitationScanBibliographyJob).
        $diag = $claim['match_diagnostics'] ?? null;
        $wave = $diag['diagnostics']['wave_results']['web_fetch']
            ?? $diag['wave_results']['web_fetch']
            ?? null;

        if (! is_array($wave) || empty($wave['outcome'])) {
            return null;
        }

        return [
            'outcome' => $wave['outcome'],
            'reason' => $wave['reason'] ?? null,
            'http_status' => $wave['http_status'] ?? null,
            'channel' => $wave['channel'] ?? null,
            'url' => $wave['url'] ?? null,
            // The title the refused page/video itself declared — when it matches the
            // citation, the refusal still CONFIRMED the reference exists (paywall,
            // foreign-language video).
            'title' => $wave['title'] ?? null,
        ];
    }

    /**
     * "This citation's own anchor looks wrong" — surfaced BEFORE the reviewer
     * judges the citation, because a mislinked anchor means the claim/source
     * pairing under review was never made by the author (chacko c187:
     * `(Singh, 2025)` pointing at a 2024 Walrus article, which cost a manual
     * SQL dig to discover). Null when the anchor and the entry agree, or when
     * there is nothing to compare.
     *
     * @param array<string, string[]> $anchorYears
     * @param array<string, string> $entryYears
     */
    private function anchorWarning(?string $ref, array $anchorYears, array $entryYears, array $claim): ?string
    {
        $nodeId = $claim['node_id'] ?? null;
        if ($ref === null || $nodeId === null) {
            return null;
        }
        // The anchor in THIS claim's own paragraph (see anchorYearsByReference).
        $displayed = $anchorYears["{$nodeId}|{$ref}"] ?? [];
        if ($displayed === []) {
            return null;
        }
        $entryYear = $entryYears[$ref] ?? null;
        if ($entryYear === null) {
            return null;
        }
        // ANY disagreeing anchor is worth flagging, not only a wholly
        // disagreeing set: a bibliography entry carries ONE year, so an
        // anchor showing a different one is either a mislink or an author
        // inconsistency. Requiring every anchor to disagree let a correct
        // second citation in the same paragraph mask the wrong one (chacko's
        // savera2024: "Savera, 2022" and "Savera, 2024" both target the 2024
        // entry, in one paragraph).
        $mismatched = array_values(array_filter($displayed, fn ($y) => $y !== $entryYear));
        if ($mismatched === []) {
            return null;
        }
        $title = $claim['llm_metadata']['title'] ?? null;
        return sprintf(
            'In-text anchor displays %s but points at %s (%s%s) — check the pairing before judging the citation.',
            implode('/', $mismatched),
            $ref,
            $entryYear,
            $title ? ': ' . mb_strimwidth((string) $title, 0, 60, '…') : ''
        );
    }

    /** Same derivation as ClaimsJoiner::row — no source resolved means the verdict IS "source not found". */
    private function verdict(array $claim): string
    {
        if (empty($claim['source_book_id'])) {
            return 'source_not_found';
        }
        return $claim['llm_verdict']['support'] ?? 'insufficient';
    }

    /**
     * Triage rows (citation:study:triage --write output) keyed by gt_id.
     * Absent file → empty map; the pane just says "run triage for OCR checks".
     *
     * @return array<string, array{status: string, invented_tokens: string, diffs: string}>
     */
    private function loadTriage(CorpusManifest $manifest, string $slug): array
    {
        $path = $manifest->resultsDir() . "/triage/{$slug}.csv";
        if (!is_file($path)) {
            return [];
        }
        $out = [];
        $fh = fopen($path, 'r');
        $header = fgetcsv($fh);
        if ($header === false) {
            fclose($fh);
            return [];
        }
        $idx = array_flip($header);
        while (($row = fgetcsv($fh)) !== false) {
            $gtId = $row[$idx['gt_id']] ?? null;
            if (!$gtId) {
                continue;
            }
            $out[$gtId] = [
                'status' => $row[$idx['status']] ?? '',
                'invented_tokens' => $row[$idx['invented_tokens']] ?? '',
                'diffs' => $row[$idx['diffs']] ?? '',
            ];
        }
        fclose($fh);
        return $out;
    }
}
