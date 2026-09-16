<?php

namespace App\Services\CitationStudy;

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
                'bib_citation' => $claim['bib_citation'] ?? null,
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
                    'verification_tier' => $claim['verification_tier'] ?? null,
                    'evidence_type' => $claim['evidence_type'] ?? null,
                    'passages' => $claim['source_passages'] ?? [],
                ],
                'source_material_sent' => $claim['source_material_sent'] ?? null,
                'gt' => $gt === null ? null : [
                    'gt_id' => $gt['gt_id'],
                    'label' => $gt['label'],
                    'footnote_marker' => $gt['footnote_marker'] ?? null,
                    'corruption_meta' => $gt['corruption_meta'] ?? null,
                ],
                'triage' => $gt !== null ? ($triage[$gt['gt_id']] ?? null) : null,
                'adjudication' => $adjudications[$key] ?? null,
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
