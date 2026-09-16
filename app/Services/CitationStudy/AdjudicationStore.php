<?php

namespace App\Services\CitationStudy;

use RuntimeException;

/**
 * Human adjudications of the AI citation review, per corpus book.
 *
 * The workbench (/maintainer/study) records a TWO-AXIS verdict per citation:
 * the ground-truth LABEL the human assigns (feeds the study baseline) and,
 * when the AI flagged the citation, WHOSE failure it was (feeds system
 * improvement — a resolver gap and an OCR-mangled citation demand different
 * fixes but look identical in the AI's output).
 *
 * Storage is a committed file per book at
 * study/corpora/{corpus}/adjudications/{slug}.json — deliberately NOT under
 * study/results (gitignored): adjudications are part of the paper's audit
 * trail, and freezing a corpus hashes them together with the ground truth.
 *
 * Adjudicating never touches ground_truth.json by itself. The explicit
 * applyToGroundTruth() step folds labels in — refused on a frozen corpus —
 * so every baseline change is a deliberate, diffable act.
 */
class AdjudicationStore
{
    public const CAUSES = [
        'correct_flag',        // the AI was right — the citation is genuinely bad
        'resolver_gap',        // real source, exists in an index, we failed to find it
        'conversion_mangled',  // our PDF/OCR conversion corrupted the citation text
        'grey_literature',     // real source that is legitimately unindexed
        'other',
    ];

    public function path(CorpusManifest $manifest, array $book): string
    {
        return $manifest->path("adjudications/{$book['slug']}.json");
    }

    /** @return array{book: string, adjudications: array<string,array>} */
    public function load(CorpusManifest $manifest, array $book): array
    {
        $path = $this->path($manifest, $book);
        if (!is_file($path)) {
            return ['book' => $book['slug'], 'adjudications' => []];
        }
        $data = json_decode((string) file_get_contents($path), true);
        if (!is_array($data) || !isset($data['adjudications']) || !is_array($data['adjudications'])) {
            throw new RuntimeException("Adjudications file invalid for '{$book['slug']}': {$path}");
        }
        return $data;
    }

    /**
     * Record (or overwrite) one adjudication. Key is the gt_id when the claim
     * is bound to ground truth, else "ref:{referenceId}" so unbound claims can
     * still carry a verdict.
     *
     * @return array the stored record
     */
    public function put(
        CorpusManifest $manifest,
        array $book,
        string $key,
        string $label,
        ?string $cause,
        ?string $note,
        ?string $referenceId,
        ?string $runId,
        string $adjudicatedBy,
        ?string $foundUrl = null,
    ): array {
        if (!in_array($label, CorpusManifest::LABELS, true)) {
            throw new RuntimeException("Invalid label '{$label}'.");
        }
        if ($cause !== null && !in_array($cause, self::CAUSES, true)) {
            throw new RuntimeException("Invalid cause '{$cause}'.");
        }
        if ($foundUrl !== null && $foundUrl !== '' && !preg_match('#^https?://#i', $foundUrl)) {
            throw new RuntimeException('found_url must be an http(s) URL.');
        }

        $data = $this->load($manifest, $book);
        $record = [
            'gt_id' => str_starts_with($key, 'ref:') ? null : $key,
            'referenceId' => $referenceId,
            'run_id' => $runId,
            'label' => $label,
            'cause' => $cause,
            'note' => $note !== null && $note !== '' ? $note : null,
            // Where the HUMAN found the source (a resolver_gap adjudication
            // with a found_url is a ready-made resolver test case: "a human
            // found it here — why didn't we?").
            'found_url' => $foundUrl !== null && $foundUrl !== '' ? $foundUrl : null,
            'adjudicated_at' => now()->toIso8601String(),
            'adjudicated_by' => $adjudicatedBy,
        ];
        $data['adjudications'][$key] = $record;
        $this->save($manifest, $book, $data);
        return $record;
    }

    /** Remove one adjudication (undo). Returns true when something was removed. */
    public function remove(CorpusManifest $manifest, array $book, string $key): bool
    {
        $data = $this->load($manifest, $book);
        if (!isset($data['adjudications'][$key])) {
            return false;
        }
        unset($data['adjudications'][$key]);
        $this->save($manifest, $book, $data);
        return true;
    }

    /**
     * Fold adjudicated labels into the book's ground_truth.json.
     *
     * Only entries with a gt_id are applied (an unbound "ref:" adjudication
     * has nothing to attach to). For POSITIVE labels, cited_occurrences is
     * raised to at least 1 — ClaimsJoiner silently DROPS an unmatched positive
     * whose cited_occurrences is null/0 instead of counting it as a miss, so a
     * hand-labelled positive would otherwise vanish from the denominator.
     *
     * @return array{applied: int, skipped: string[]}
     */
    public function applyToGroundTruth(CorpusManifest $manifest, array $book): array
    {
        if ($manifest->isFrozen()) {
            throw new RuntimeException(
                "Corpus '{$manifest->corpus}' is frozen — ground truth must not change."
            );
        }

        $data = $this->load($manifest, $book);
        if ($data['adjudications'] === []) {
            return ['applied' => 0, 'skipped' => []];
        }

        $groundTruth = $manifest->loadGroundTruth($book);
        $byGtId = [];
        foreach ($groundTruth['entries'] as $i => $entry) {
            $byGtId[$entry['gt_id']] = $i;
        }

        $applied = 0;
        $skipped = [];
        foreach ($data['adjudications'] as $key => $record) {
            $gtId = $record['gt_id'] ?? null;
            if ($gtId === null || !isset($byGtId[$gtId])) {
                $skipped[] = $key;
                continue;
            }
            $i = $byGtId[$gtId];
            $groundTruth['entries'][$i]['label'] = $record['label'];
            // Same rule the skeleton generator uses: negatives expect a pass,
            // everything else (positives AND non-scored suspect/unverifiable)
            // expects a flag.
            $groundTruth['entries'][$i]['expected_detection'] =
                in_array($record['label'], CorpusManifest::NEGATIVE_LABELS, true) ? 'pass' : 'flag';
            $isPositive = in_array($record['label'], CorpusManifest::POSITIVE_LABELS, true);
            if ($isPositive) {
                $groundTruth['entries'][$i]['cited_occurrences'] =
                    max(1, (int) ($groundTruth['entries'][$i]['cited_occurrences'] ?? 0));
            }
            $applied++;
        }

        if ($applied > 0) {
            $manifest->saveGroundTruth($book, $groundTruth);
        }
        return ['applied' => $applied, 'skipped' => $skipped];
    }

    private function save(CorpusManifest $manifest, array $book, array $data): void
    {
        $path = $this->path($manifest, $book);
        @mkdir(dirname($path), 0775, true);
        file_put_contents(
            $path,
            json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n"
        );
    }
}
