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
    /**
     * WHAT the citation actually supports — the ground truth's third axis.
     *
     * Added 2026-09-19 because the support scale has no fixed DENOMINATOR, and a verdict is
     * meaningless without one. "Unlikely" conflated two opposite findings: the source supports none
     * of this, versus the source supports exactly the part it was cited for and nothing else. The
     * real case: "This article is part of a Special Issue commemorating the fiftieth anniversary of
     * the campaign for a NIEO (UN 1974a, 1974b)" — the 1974 Declaration is direct evidence the
     * campaign happened, and silent about a journal issue published fifty years later.
     *
     * Recorded here rather than folded into the label, because THIS axis is what makes the ground
     * truth denominator-INDEPENDENT: the same label then scores either verify prompt
     * (`services.citation_review.verify_scope`). A `fragment_only` claim SHOULD read unsupported
     * under the strict prompt and supported under the fragment prompt — both correct, and only
     * distinguishable because the human said which.
     *
     * Distinct from the `claim_scoping` CAUSE, which is about OUR extractor grabbing the wrong
     * text. Here the extraction is right and the citation simply backs one part of it.
     */
    public const SUPPORTED_SCOPES = [
        // The source supports the claim sentence as a whole.
        'whole_claim',
        // The source supports a specific component of the sentence, not the rest. Say which in the note.
        'fragment_only',
        // The source supports none of it.
        'none',
        // Cannot tell without the source (blocked, dead, not retrieved).
        'undetermined',
    ];

    public const CAUSES = [
        'correct_flag',        // the AI was right — the citation is genuinely bad
        'resolver_gap',        // real source, exists in an index, we failed to find it
        'conversion_mangled',  // our PDF/OCR conversion corrupted the citation text
        'claim_scoping',       // our extractor attributed text this citation never
                               // covered: the wrong slice of a grouped citation
                               // (chacko c51: one claim fanned out to all four group
                               // members) or an adjacent UNCITED sentence grabbed
                               // instead of the cited one (chacko c187: the sentence
                               // AFTER the (Singh, 2025) anchor became its claim)
        'citation_mislink',    // our in-text linker minted or misdirected the ANCHOR:
                               // a bare year in a range ("Modi's first term (2014-2019)")
                               // became a citation, or a real citation linked to the
                               // wrong entry ("Modi, 2019" → #modi2024d) — so the AI
                               // reviewed a claim-source pairing the author never made
                               // (chacko c130)
        'evidence_truncated',  // source correctly resolved but our SNAPSHOT clipped the
                               // evidence — the supporting text exists beyond what we
                               // stored (chacko c128: WebFetchService's 6K cap kept the
                               // first fifth of a speech; the proving passage was mid-way)
        'grey_literature',     // real source that is legitimately unindexed
        'citation_typo',       // the citation is real and supports the claim but
                               // carries a MINOR error (missing/wrong word in the
                               // title, off-by-one year/page) that likely defeated
                               // exact matching. Label stays verified_intact — the
                               // typo is not an integrity problem; the count tells
                               // us how tolerant the matcher needs to be
        'access_blocked',      // the cited URL EXISTS but refused our fetcher —
                               // paywall / bot wall / rate limit (401/402/403/429,
                               // or a 200 with a subscribe-to-continue interstitial).
                               // Reuters behind a paywall is NOT a dead link; the
                               // human can often still verify in a browser
        'dead_link',           // the CITED URL is rotted — 404/410 or a soft-404
                               // ("Oops! That page can't be found" served as 200).
                               // The work may exist elsewhere; what failed is the
                               // link the author printed (or it aged out since
                               // publication) — distinct from resolver_gap, where
                               // a live findable source was missed by our ladder
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
        ?bool $referenceExists = null,
        ?string $supportedScope = null,
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
        if ($supportedScope !== null && !in_array($supportedScope, self::SUPPORTED_SCOPES, true)) {
            throw new RuntimeException("Invalid supported_scope '{$supportedScope}'.");
        }

        $data = $this->load($manifest, $book);
        $record = [
            'gt_id' => str_starts_with($key, 'ref:') ? null : $key,
            'referenceId' => $referenceId,
            'run_id' => $runId,
            'label' => $label,
            'cause' => $cause,
            // Denominator-independent ground truth: what the citation actually supports, so the
            // same label can score either verify-prompt variant. See SUPPORTED_SCOPES.
            'supported_scope' => $supportedScope,
            'note' => $note !== null && $note !== '' ? $note : null,
            // Where the HUMAN found the source (a resolver_gap adjudication
            // with a found_url is a ready-made resolver test case: "a human
            // found it here — why didn't we?").
            'found_url' => $foundUrl !== null && $foundUrl !== '' ? $foundUrl : null,
            // Verification is TWO-LEVEL and a paywall splits them: the WORK's
            // existence (title/author/outlet match — visible behind most
            // paywalls) vs whether it SUPPORTS the claim (needs the body).
            // The label carries the claim level; this flag carries the
            // reference level, so an `unverifiable` row with
            // reference_exists=true still counts as a fabrication-NEGATIVE in
            // analysis. true = confirmed real, false = could not even confirm
            // the work, null = not assessed.
            'reference_exists' => $referenceExists,
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
    public function applyToGroundTruth(CorpusManifest $manifest, array $book, ?string $currentRunId = null): array
    {
        if ($manifest->isFrozen()) {
            throw new RuntimeException(
                "Corpus '{$manifest->corpus}' is frozen — ground truth must not change."
            );
        }

        $data = $this->load($manifest, $book);
        if ($data['adjudications'] === []) {
            return ['applied' => 0, 'skipped' => [], 'stale_mislinks' => []];
        }

        $groundTruth = $manifest->loadGroundTruth($book);
        $byGtId = [];
        foreach ($groundTruth['entries'] as $i => $entry) {
            $byGtId[$entry['gt_id']] = $i;
        }

        $applied = 0;
        $skipped = [];
        $staleMislinks = [];
        foreach ($data['adjudications'] as $key => $record) {
            // A citation_mislink verdict describes a PHANTOM anchor in the copy
            // it was recorded against. After a reimport (linker fixes land, the
            // book gets a new run), those anchors usually link CORRECTLY — so
            // applying e.g. not_a_citation to the entry would wrongly unscore
            // now-genuine pairings. List them for re-check instead of applying.
            if (($record['cause'] ?? null) === 'citation_mislink'
                && $currentRunId !== null
                && ($record['run_id'] ?? null) !== $currentRunId
            ) {
                $staleMislinks[] = $key;
                continue;
            }
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
        return ['applied' => $applied, 'skipped' => $skipped, 'stale_mislinks' => $staleMislinks];
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
