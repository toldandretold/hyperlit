<?php

namespace App\Services\CitationStudy;

use RuntimeException;

/**
 * Human adjudications of the AI citation review, per corpus book.
 *
 * The workbench (/maintainer/study) asks the reviewer TWO separate questions per
 * citation, and stores each answer in its own field:
 *
 *   1. `reference` — is the cited work REAL, and cited correctly? (REFERENCE_STATUSES;
 *      `reference_errors` names what is wrong when the work is real but mis-cited.)
 *   2. `supported_scope` — does that work SUPPORT the claim? (SUPPORTED_SCOPES;
 *      asked only when the work is real.)
 *
 * `label` — the single value ground truth and every metric score on — is DERIVED
 * from those two answers by deriveLabel() and by nothing else. The reviewer never
 * picks it. It used to be picked directly from one row of chips that mixed both
 * questions ("verified intact" was defined as real AND supporting), while the
 * scope chips asked the second question again underneath — so a reviewer
 * answering the two questions separately recorded "verified intact · supports
 * none of it", which scored as a citation the AI should pass (deloitte, eight
 * rows, found 2026-11-22). Records written before the split carry no `reference`;
 * normaliseRecord() gives them one on load.
 *
 * A third, independent field, `cause`, records WHOSE failure it was when the AI
 * flagged the citation (feeds system improvement — a resolver gap and an
 * OCR-mangled citation demand different fixes but look identical in the AI's
 * output). It never affects the label.
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
     * Question 1 — is the cited work real, and is it cited correctly?
     *
     * `verified` and `details_wrong` both mean the WORK EXISTS; only they go on to
     * question 2. `details_wrong` is a real work the citation describes wrongly
     * (deloitte c02: the right report, credited to the wrong committee) — neither
     * a fabrication nor a typo, and until this field existed there was nowhere to
     * record it. What is wrong goes in `reference_errors`; the right value goes in
     * the note. It does not change the label: scoring follows claim support.
     */
    public const REFERENCE_STATUSES = [
        'verified',        // the work exists and the citation describes it correctly
        'details_wrong',   // the work exists; the citation gets author/title/year/venue wrong
        'fabricated',      // the work does not exist
        'unverifiable',    // could not establish whether the work exists
        'suspect',         // something is off, cannot pin it down (not scored)
        'not_a_citation',  // the reviewed pairing is not in the author's text (not scored)
    ];

    /** Cap on `reference_correction`, in characters. Mirrored by the request validation and the form. */
    public const REFERENCE_CORRECTION_MAX_CHARS = 500;

    /**
     * What a `details_wrong` citation gets wrong. At least one is required. `other` is the
     * escape hatch — the list must never be what stops a reviewer recording a finding; the
     * specifics go in `reference_correction`.
     */
    public const REFERENCE_ERRORS = ['author', 'title', 'year', 'venue', 'volume_issue', 'pages', 'url', 'other'];

    /** The reference answers that mean "the work exists" — the only ones question 2 applies to. */
    public const REAL_REFERENCES = ['verified', 'details_wrong'];

    /**
     * Question 2 — WHAT does the cited work actually support?
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

    /**
     * Is the URL OUR SYSTEM supplied the right one for the citation? Asked (workbench:
     * systemSuppliedUrl) only when we found a URL the citation did not print — a printed URL is
     * the author's pointer, not our call. Orthogonal to the label and the verdict: web search can
     * land on a topically adjacent page that still earns a `likely` — the right answer read off
     * the wrong source (deloitte-2025-pdf, 2026-11-22) — and nothing else could count that.
     * Stored as same_work / different_work (right URL / wrong URL in the UI).
     * null = not assessed.
     */
    public const SOURCE_MATCHES = [
        'same_work',       // right URL: it IS the cited work (any edition/copy)
        'different_work',  // wrong URL: some other page — the right one goes in found_url
    ];

    /**
     * Cap on quoted evidence, in characters.
     *
     * The point is SELECTIVE quotation: enough to show what the reviewer read
     * and judged, never enough to reproduce a closed-access source. ~1500
     * characters is a few short quotations; a reviewer who needs more is
     * summarising rather than evidencing, and the `note` is the place for that.
     * Mirrored by the request validation and by the UI's live counter.
     */
    public const EVIDENCE_MAX_CHARS = 1500;

    /**
     * Labels whose adjudications are EXPECTED to carry evidence — the scored
     * ones. The non-scored labels (`suspect`, `unverifiable`, `not_a_citation`)
     * are exempt because there is nothing to quote: you never obtained access,
     * or no citation exists at all (the phantom year-range mislinks). They
     * carry the reason in `note` instead. Derived from the scoring constants so
     * a new scored label cannot silently escape the coverage denominator.
     *
     * @return list<string>
     */
    public static function evidenceExpectedLabels(): array
    {
        return array_merge(CorpusManifest::POSITIVE_LABELS, CorpusManifest::NEGATIVE_LABELS);
    }

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
        $data['adjudications'] = array_map([self::class, 'normaliseRecord'], $data['adjudications']);
        return $data;
    }

    /**
     * THE definition of the scored label: the two answers in, one label out.
     *
     *   reference                 scope            → label
     *   fabricated                —                → fabricated_reference
     *   unverifiable              —                → unverifiable
     *   suspect / not_a_citation  —                → the same
     *   verified / details_wrong  whole / part     → verified_intact
     *   verified / details_wrong  none             → claim_distortion (source_swap when the
     *                                                claim belongs to a different work)
     *   verified / details_wrong  can't tell       → unverifiable
     *   verified / details_wrong  (not answered)   → verified_intact
     *
     * The last row is the pre-split behaviour, kept so records made before the
     * scope question existed do not silently leave the confusion matrix; the
     * workbench no longer lets a new verdict be saved that way. Mirrored for the
     * form's live "scored as" line by resources/js/workbenches/study/verdictAxes.ts;
     * both are pinned to tests/fixtures/study/verdictDerivation.json.
     */
    public static function deriveLabel(string $reference, ?string $scope, bool $fromOtherWork = false): string
    {
        if (!in_array($reference, self::REAL_REFERENCES, true)) {
            return $reference === 'fabricated' ? 'fabricated_reference' : $reference;
        }

        return match ($scope) {
            'none' => $fromOtherWork ? 'source_swap' : 'claim_distortion',
            'undetermined' => 'unverifiable',
            default => 'verified_intact',
        };
    }

    /**
     * Read the two answers back out of a bare label (a record from before the
     * split, or a caller that still sends one).
     *
     * @return array{0: string, 1: ?string, 2: bool} [reference, scope the label implies, from_other_work]
     */
    public static function axesFromLegacyLabel(string $label, ?bool $referenceExists): array
    {
        return match ($label) {
            'fabricated_reference' => ['fabricated', null, false],
            'claim_distortion' => ['verified', 'none', false],
            'source_swap' => ['verified', 'none', true],
            // "Unverifiable" covered both "cannot confirm the work" and "the work is
            // real but I could not read it"; only the work-exists tick told them apart.
            'unverifiable' => $referenceExists === true ? ['verified', 'undetermined', false] : ['unverifiable', null, false],
            'suspect', 'not_a_citation' => [$label, null, false],
            default => ['verified', null, false],   // intact, verified_intact
        };
    }

    /**
     * Give a pre-split record its two answers, and re-derive its label from them.
     * A record that already has `reference` is returned untouched, so this is
     * idempotent and costs nothing once a file has been rewritten.
     *
     * The reviewer's ANSWERS never change here — only the label derived from
     * them. A record saved as "verified intact" with scope "supports none of it"
     * keeps both answers and now scores as claim_distortion, which is what those
     * two answers say.
     */
    public static function normaliseRecord(array $record): array
    {
        if (isset($record['reference'])) {
            return $record;
        }
        $label = (string) ($record['label'] ?? '');
        [$reference, $impliedScope, $fromOtherWork] = self::axesFromLegacyLabel($label, $record['reference_exists'] ?? null);
        $record['reference'] = $reference;
        $record['reference_errors'] = [];
        $record['supported_scope'] = ($record['supported_scope'] ?? null) ?? $impliedScope;
        $record['from_other_work'] = $fromOtherWork;
        $derived = self::deriveLabel($reference, $record['supported_scope'], $fromOtherWork);
        // `intact` is the machine default ("nobody has said otherwise"), not a human
        // verdict; it scores identically to verified_intact and is left as it is.
        if (!($label === 'intact' && $derived === 'verified_intact')) {
            $record['label'] = $derived;
        }

        return $record;
    }

    /**
     * Rewrite a book's file with every record normalised (normaliseRecord), and
     * report which labels moved. load() already normalises in memory, so this
     * changes no behaviour — it makes the committed file say what the code reads.
     *
     * @return array{rewritten: int, relabelled: array<string, array{from: string, to: string}>}
     */
    public function normaliseStored(CorpusManifest $manifest, array $book, bool $write = true): array
    {
        $path = $this->path($manifest, $book);
        if (!is_file($path)) {
            return ['rewritten' => 0, 'relabelled' => []];
        }
        $raw = json_decode((string) file_get_contents($path), true)['adjudications'] ?? [];
        $data = $this->load($manifest, $book);
        $rewritten = 0;
        $relabelled = [];
        foreach ($data['adjudications'] as $key => $record) {
            if ($record === ($raw[$key] ?? null)) {
                continue;
            }
            $rewritten++;
            if (($raw[$key]['label'] ?? null) !== $record['label']) {
                $relabelled[$key] = ['from' => (string) ($raw[$key]['label'] ?? ''), 'to' => $record['label']];
            }
        }
        if ($write && $rewritten > 0) {
            $this->save($manifest, $book, $data);
        }

        return ['rewritten' => $rewritten, 'relabelled' => $relabelled];
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
        ?string $label,
        ?string $cause,
        ?string $note,
        ?string $referenceId,
        ?string $runId,
        string $adjudicatedBy,
        ?string $foundUrl = null,
        ?bool $referenceExists = null,
        ?string $supportedScope = null,
        ?string $evidence = null,
        ?string $evidenceLocator = null,
        ?string $sourceMatch = null,
        ?string $reference = null,
        array $referenceErrors = [],
        bool $fromOtherWork = false,
        ?string $referenceCorrection = null,
    ): array {
        $referenceCorrection = $reference === 'details_wrong' ? trim((string) $referenceCorrection) : '';
        if ($reference !== null) {
            // The workbench path: two answers in, label derived. Whatever $label
            // carried is ignored — there is one definition of the label.
            if (!in_array($reference, self::REFERENCE_STATUSES, true)) {
                throw new RuntimeException("Invalid reference '{$reference}'.");
            }
            $referenceErrors = array_values(array_unique($referenceErrors));
            if (array_diff($referenceErrors, self::REFERENCE_ERRORS) !== []) {
                throw new RuntimeException('Invalid reference_errors.');
            }
            if ($reference === 'details_wrong' && $referenceErrors === []) {
                throw new RuntimeException('details_wrong needs at least one of: ' . implode(', ', self::REFERENCE_ERRORS) . '.');
            }
            if ($reference !== 'details_wrong') {
                $referenceErrors = [];
            }
            if (!in_array($reference, self::REAL_REFERENCES, true)) {
                // No real work, so nothing for it to support.
                $supportedScope = null;
            }
            $fromOtherWork = $fromOtherWork && $supportedScope === 'none';
            $label = self::deriveLabel($reference, $supportedScope, $fromOtherWork);
            $referenceExists = match (true) {
                in_array($reference, self::REAL_REFERENCES, true) => true,
                in_array($reference, ['fabricated', 'unverifiable'], true) => false,
                default => null,
            };
        } else {
            // A caller that still sends a bare label (tests, scripts). The label is
            // kept as sent and the two answers are read back out of it, so every
            // stored record carries both.
            if ($label === null || !in_array($label, CorpusManifest::LABELS, true)) {
                throw new RuntimeException("Invalid label '{$label}'.");
            }
            [$reference, $impliedScope, $fromOtherWork] = self::axesFromLegacyLabel($label, $referenceExists);
            $supportedScope ??= $impliedScope;
            $referenceErrors = [];
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
        if ($sourceMatch !== null && !in_array($sourceMatch, self::SOURCE_MATCHES, true)) {
            throw new RuntimeException("Invalid source_match '{$sourceMatch}'.");
        }

        $data = $this->load($manifest, $book);
        $record = [
            'gt_id' => str_starts_with($key, 'ref:') ? null : $key,
            'referenceId' => $referenceId,
            'run_id' => $runId,
            // Question 1 — is the work real / cited correctly. See REFERENCE_STATUSES.
            'reference' => $reference,
            'reference_errors' => $referenceErrors,
            // For details_wrong: what the citation SHOULD have said, and how the
            // reviewer knows ("Report is by the Standing Committee on Education and
            // Employment — title page"). Its own field, beside the error it backs,
            // so the correction is not lost among general reasoning in `note`.
            'reference_correction' => $referenceCorrection !== '' ? $referenceCorrection : null,
            // Question 2 — what the work supports. See SUPPORTED_SCOPES. `from_other_work`
            // refines `none`: the claim is real but belongs to a different work.
            'supported_scope' => $supportedScope,
            'from_other_work' => $fromOtherWork,
            // DERIVED from the two answers above (deriveLabel) — what scoring reads.
            'label' => $label,
            'cause' => $cause,
            'note' => $note !== null && $note !== '' ? $note : null,
            // Where the HUMAN found the source (a resolver_gap adjudication
            // with a found_url is a ready-made resolver test case: "a human
            // found it here — why didn't we?"). The meaning FOLLOWS THE LABEL:
            // on a fabricated_reference row there is no source, so this URL is
            // COUNTER-EVIDENCE (the TOC/index/review the human checked) and
            // must never be read as "where the cited work lives" — only
            // resolver_gap-shaped rows (and source_match = different_work
            // rows: "we resolved the wrong work; the right one is here")
            // qualify as resolver test cases.
            'found_url' => $foundUrl !== null && $foundUrl !== '' ? $foundUrl : null,
            // A yes/no shadow of `reference`, kept because dataset.csv has always
            // carried it: true = the work exists, false = fabricated or could not
            // be confirmed, null = not assessed. A paywalled source whose title
            // and author check out is reference=verified, scope=undetermined —
            // label `unverifiable`, but reference_exists=true, so it still counts
            // as a fabrication-NEGATIVE in analysis.
            'reference_exists' => $referenceExists,
            // Resolution correctness — see SOURCE_MATCHES.
            'source_match' => $sourceMatch,
            // THE QUOTES THE REVIEWER READ. A human label is otherwise an
            // assertion with no artifact behind it — and "we manually verified
            // this citation is fine" is exactly the claim a reader of the paper
            // probes first. Short, selective quotation (capped at
            // self::EVIDENCE_MAX_CHARS) so a closed-access source can be
            // evidenced without reproducing it.
            'evidence' => self::normaliseEvidence($evidence),
            // WHERE in the source — "p. 412", "0:01-1:51, auto-captions". The
            // source's identity is already carried by found_url and the
            // resolved source; this is the position within it.
            'evidence_locator' => $evidenceLocator !== null && $evidenceLocator !== '' ? $evidenceLocator : null,
            'adjudicated_at' => now()->toIso8601String(),
            'adjudicated_by' => $adjudicatedBy,
        ];
        // Evidence is ALWAYS attributed, whichever path recorded it. Stamped
        // here too (and not only in putEvidence) because ground truth carries
        // the quotes onward, and an unattributed quotation in the published
        // artifact is exactly the thing evidence exists to prevent. When the
        // two arrive together the stamps simply match.
        $record['evidenced_at'] = $record['evidence'] === null ? null : $record['adjudicated_at'];
        $record['evidenced_by'] = $record['evidence'] === null ? null : $adjudicatedBy;

        $data['adjudications'][$key] = $record;
        $this->save($manifest, $book, $data);
        return $record;
    }

    /**
     * Add or replace the EVIDENCE on an adjudication that already exists,
     * merging rather than replacing the record.
     *
     * Separate from put() on purpose, twice over. (1) put() replaces the record
     * wholesale, and that is a property worth keeping — it is what guarantees a
     * re-adjudication cannot leave a stale cause or scope behind from the
     * previous verdict. (2) Evidence is routinely added in a later sitting than
     * the verdict it backs, so it has its own seam and its own stamps rather
     * than going through a whole re-adjudication.
     *
     * @return array the updated record
     */
    public function putEvidence(
        CorpusManifest $manifest,
        array $book,
        string $key,
        ?string $evidence,
        ?string $evidenceLocator,
        string $evidencedBy,
    ): array {
        $data = $this->load($manifest, $book);
        if (!isset($data['adjudications'][$key])) {
            throw new RuntimeException("No adjudication to attach evidence to for '{$key}'.");
        }

        $record = $data['adjudications'][$key];
        $record['evidence'] = self::normaliseEvidence($evidence);
        $record['evidence_locator'] = $evidenceLocator !== null && $evidenceLocator !== '' ? $evidenceLocator : null;
        // Stamped separately from adjudicated_at/by: evidence is routinely added
        // later (and possibly by someone else) than the verdict it supports, and
        // flattening the two would misreport when the verdict was made.
        $record['evidenced_at'] = $record['evidence'] === null ? null : now()->toIso8601String();
        $record['evidenced_by'] = $record['evidence'] === null ? null : $evidencedBy;

        $data['adjudications'][$key] = $record;
        $this->save($manifest, $book, $data);

        return $record;
    }

    /**
     * Set (or clear) source_match on an adjudication that already exists, merging like
     * putEvidence: the question sits in the Resolved Source panel, next to the URL it asks about,
     * so it is answered on its own click — not by re-making the verdict. With no verdict yet, the
     * workbench holds the answer and sends it with the verdict instead (a label-less record would
     * break the consumers that read ['label']).
     *
     * @return array the updated record
     */
    public function putSourceMatch(CorpusManifest $manifest, array $book, string $key, ?string $sourceMatch): array
    {
        if ($sourceMatch !== null && !in_array($sourceMatch, self::SOURCE_MATCHES, true)) {
            throw new RuntimeException("Invalid source_match '{$sourceMatch}'.");
        }
        $data = $this->load($manifest, $book);
        if (!isset($data['adjudications'][$key])) {
            throw new RuntimeException("No adjudication to attach source_match to for '{$key}'.");
        }
        $data['adjudications'][$key]['source_match'] = $sourceMatch;
        $this->save($manifest, $book, $data);

        return $data['adjudications'][$key];
    }

    /**
     * Tidy pasted quotations without altering their words.
     *
     * Evidence arrives by paste, usually out of a PDF or a rendered page, so it
     * routinely carries CRLF or lone-CR line endings and runs of blank lines.
     * Normalising HERE rather than at render time is what makes "one quote per
     * paragraph" a real invariant instead of a hope — and a lone \r inside a
     * quoted CSV field is mis-parsed by several readers, so dataset.csv depends
     * on it too. Never truncates: the length cap belongs to the request
     * validation, where exceeding it is an error the reviewer must see rather
     * than a silent shortening of their quotation.
     */
    private static function normaliseEvidence(?string $evidence): ?string
    {
        if ($evidence === null) {
            return null;
        }
        $clean = preg_replace("/\r\n?/", "\n", $evidence) ?? $evidence;
        $clean = preg_replace("/\n{3,}/", "\n\n", $clean) ?? $clean;
        $clean = trim($clean);

        return $clean === '' ? null : $clean;
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
            // The quotes travel WITH the label. Ground truth is the artifact a
            // reader of the paper is handed, so a label that arrived by human
            // judgement should carry its evidence in the same file rather than
            // only in the adjudications the reader would have to be told about.
            // Written only when present, so machine-labelled entries stay clean.
            // An INHERITED verdict (the workbench's Ibid/same-work inherit, whose
            // note names its antecedent) resolves to the antecedent's quotes —
            // a fabrication proof is about the WORK, so it holds for every
            // citation of it, and the ground-truth entry records the provenance.
            $source = $record;
            if (trim((string) ($record['evidence'] ?? '')) === '') {
                $donor = $this->resolveInheritedEvidence($record, $data['adjudications']);
                if ($donor !== null) {
                    $source = $donor['record'];
                    $groundTruth['entries'][$i]['evidence_inherited_from'] = $donor['from'];
                }
            }
            foreach (['evidence', 'evidence_locator', 'evidenced_by', 'evidenced_at'] as $field) {
                if (($source[$field] ?? null) !== null && $source[$field] !== '') {
                    $groundTruth['entries'][$i][$field] = $source[$field];
                }
            }
            $applied++;
        }

        if ($applied > 0) {
            $manifest->saveGroundTruth($book, $groundTruth);
        }
        return ['applied' => $applied, 'skipped' => $skipped, 'stale_mislinks' => $staleMislinks];
    }

    /**
     * The adjudication an inherited verdict's evidence RESOLVES to, or null.
     *
     * The workbench's inherit button writes a machine-shaped note naming the
     * antecedent ("source identity inherited from antecedent {id} (Ibid)" /
     * "… from {id} (same work, cited independently)"); {id} is the antecedent
     * claim's gt_id when it was bound, else its referenceId. The donor must
     * carry the SAME label (a different label is a different judgement — its
     * proof does not transfer) and non-empty evidence. Resolution happens at
     * APPLY time, not save time, so evidence added to the antecedent in a later
     * sitting still reaches every verdict that inherits from it.
     *
     * @param array<string, array<string, mixed>> $adjudications
     * @return array{record: array<string, mixed>, from: string}|null
     */
    public function resolveInheritedEvidence(array $record, array $adjudications): ?array
    {
        // The proof can sit several hops away — deloitte c24's note names c23, whose note
        // names c22, whose note names c131, where the quotes actually live. Each hop follows
        // the inherit button's machine-shaped note; an unevidenced middle link never blocks
        // resolution, and the label must agree at every hop (a different label is a different
        // judgement — its proof does not transfer). Cycle-guarded, bounded.
        $current = $record;
        $visited = [];
        for ($hop = 0; $hop < 10; $hop++) {
            if (!preg_match('/source identity inherited from (?:antecedent )?(\S+)/',
                (string) ($current['note'] ?? ''), $m)) {
                return null;
            }
            $anteId = $m[1];
            if (isset($visited[$anteId])) {
                return null;
            }
            $visited[$anteId] = true;

            $evidenced = null;
            $link = null;
            foreach ($adjudications as $donor) {
                if (($donor['gt_id'] ?? null) !== $anteId && ($donor['referenceId'] ?? null) !== $anteId) {
                    continue;
                }
                if (($donor['label'] ?? null) !== ($record['label'] ?? null)) {
                    continue;
                }
                if (trim((string) ($donor['evidence'] ?? '')) !== '') {
                    $evidenced = $donor;
                    break;
                }
                $link ??= $donor;      // unevidenced, but its own note may lead onward
            }
            if ($evidenced !== null) {
                return ['record' => $evidenced, 'from' => $anteId];
            }
            if ($link === null) {
                return null;
            }
            $current = $link;
        }

        return null;
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
