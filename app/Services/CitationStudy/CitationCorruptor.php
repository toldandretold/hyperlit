<?php

namespace App\Services\CitationStudy;

use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Deterministic citation corruption for the synthetic study arm.
 *
 * Takes a clean author-date markdown article + a corruption spec and produces
 * corrupted.md plus a per-citation ground_truth.json. All corruption is
 * rule-based and driven by StudyPrng, so the exact same inputs regenerate the
 * exact same outputs (guarded by --check and CorruptorDeterminismTest) — a
 * hard requirement for the paper's methods section.
 *
 * Three operators:
 * - fabrication: a bibliography entry (and every in-text callout to it) is
 *   replaced by an invented reference. Expected detection: source not found /
 *   fabrication flag.
 * - source_swap: one in-text callout is re-pointed at a different real entry
 *   in the same bibliography. Expected detection: claim unsupported by the
 *   (wrong) source.
 * - claim_distortion: the sentence carrying a callout is rewritten (negation,
 *   x10 inflation, direction reversal) so the real source no longer supports
 *   it. Expected detection: claim unsupported.
 *
 * v1 parses author-date citations only — "(Smith, 2019)", "(Smith & Jones
 * 2019; Doe, 2020)", narrative "Smith (2019)". Footnote-style documents are
 * hand-labelled instead (the binder + joiner don't care where labels came
 * from). A document the parser can't handle fails loudly: it gets excluded
 * from the corpus, never guessed at.
 */
class CitationCorruptor
{
    private const REFS_HEADING = '/^#{1,6}\s*(references|bibliography|works\s+cited|reference\s+list)\s*$/mi';
    private const YEAR = '(?:1[89]|20)\d{2}[a-z]?';

    // Pools for fabricated references. Surnames are deliberately rare strings;
    // the local-library ILIKE guard below catches collisions anyway.
    private const FAKE_SURNAMES = [
        'Grenmark', 'Ovelli', 'Tarnowitz', 'Quillfeldt', 'Brenholm',
        'Askevold', 'Ferrandino', 'Welteroth', 'Kastrupsen', 'Olwendale',
    ];
    private const FAKE_INITIALS = ['A. R.', 'J. M.', 'L. K.', 'P. T.', 'S. E.', 'C. D.', 'M. V.', 'H. B.'];
    private const FAKE_TITLES = [
        'Recursive boundary effects in comparative institutional analysis',
        'Toward a typology of deferred consensus in collaborative governance',
        'Measurement drift and the limits of longitudinal replication',
        'Reassessing threshold models of collective attention',
        'The mediating role of infrastructural opacity in knowledge transfer',
        'Counterfactual baselines for mixed-method process tracing',
        'Asymmetric diffusion in peer evaluation networks',
        'On the stability of derived indicators under archival revision',
        'Latent gatekeeping and the economics of scholarly attention',
        'A framework for provenance-aware evidence synthesis',
    ];
    private const FAKE_JOURNALS = [
        'Journal of Institutional Dynamics', 'Review of Evaluative Studies',
        'International Journal of Research Synthesis', 'Studies in Scholarly Communication',
        'Quarterly Journal of Methodological Advances', 'Annals of Evidence Practice',
    ];

    /**
     * Corrupt a synthetic-arm book. Returns a summary array; writes
     * corrupted.md + ground_truth.json unless $dryRun.
     */
    public function corrupt(CorpusManifest $manifest, array $book, bool $dryRun = false): array
    {
        $slug = $book['slug'];
        $sourcePath = $manifest->path($book['source_file']);
        if (!is_file($sourcePath)) {
            throw new RuntimeException("Source file missing for '{$slug}': {$sourcePath}");
        }
        $specPath = $manifest->path($book['corruption_spec']);
        if (!is_file($specPath)) {
            throw new RuntimeException("Corruption spec missing for '{$slug}': {$specPath}");
        }
        $spec = json_decode((string) file_get_contents($specPath), true);
        if (!is_array($spec) || !isset($spec['seed'])) {
            throw new RuntimeException("Corruption spec invalid for '{$slug}' (needs at least a seed): {$specPath}");
        }

        $markdown = (string) file_get_contents($sourcePath);
        $doc = $this->parse($markdown, $slug);
        $prng = new StudyPrng((int) $spec['seed'], $slug);

        $counts = $this->resolveCounts($spec, count($doc['entries']));

        // Entries eligible for corruption must be cited in the body — the unit
        // of analysis is the citation occurrence, so an uncited fabrication
        // would never produce a claims row.
        $citedEntryIdxs = array_values(array_unique(array_map(
            fn ($occ) => $occ['entry'],
            $doc['occurrences']
        )));
        sort($citedEntryIdxs);

        // Occurrence counts per entry — recorded into ground truth so the
        // joiner can tell "legitimately uncited" from "parser dropped it".
        $occCount = array_fill(0, count($doc['entries']), 0);
        foreach ($doc['occurrences'] as $occ) {
            $occCount[$occ['entry']]++;
        }

        $needed = $counts['fabrication'] + $counts['source_swap'] + $counts['claim_distortion'];
        if ($needed > count($citedEntryIdxs)) {
            throw new RuntimeException(
                "'{$slug}': spec asks for {$needed} corruptions but only " . count($citedEntryIdxs) . ' cited entries exist.'
            );
        }
        if ($counts['source_swap'] > 0 && count($citedEntryIdxs) < 2) {
            throw new RuntimeException("'{$slug}': source_swap needs at least two cited entries.");
        }

        // Deterministic disjoint assignment: shuffle cited entries once, then
        // deal them out to fabrication → swap → distortion in order. The
        // distortion quota draws from ALL remaining entries — an entry whose
        // citing sentences match no distortion template is skipped, not fatal.
        $dealt = $prng->shuffle($citedEntryIdxs);
        $fabricated = array_splice($dealt, 0, $counts['fabrication']);
        $swapped = array_splice($dealt, 0, $counts['source_swap']);
        $distortionDeck = $dealt;
        $distorted = []; // filled during the distortion pass

        $gtEntries = [];
        $bodyEdits = [];   // [start, end, replacement] on the body text
        $refEdits = [];    // entryIdx => replacement text
        $occAdjust = array_fill(0, count($doc['entries']), 0); // swaps move a callout away from its entry
        $gtSeq = 0;

        // --- Fabrication ---------------------------------------------------
        foreach ($fabricated as $entryIdx) {
            $entry = $doc['entries'][$entryIdx];
            $fake = $this->generateFakeReference($prng, $entry);
            $this->guardFakeAgainstLibrary($fake, $slug);

            $refEdits[$entryIdx] = $fake['text'];
            foreach ($doc['occurrences'] as $occ) {
                if ($occ['entry'] !== $entryIdx) {
                    continue;
                }
                $bodyEdits[] = [
                    $occ['start'], $occ['end'],
                    $this->rewriteCallout($occ, $fake['surname'], $fake['year']),
                ];
            }

            $gtSeq++;
            $gtEntries[] = [
                'gt_id' => sprintf('%s/c%02d', $slug, $gtSeq),
                'label' => 'fabricated_reference',
                'bib_text_normalized' => GroundTruthText::normalise($fake['text']),
                'bib_text_hash' => GroundTruthText::hash($fake['text']),
                'claim_snippet' => null,
                'cited_occurrences' => $occCount[$entryIdx],
                'expected_detection' => 'source_not_found_or_rejected',
                'corruption_meta' => [
                    'type' => 'fabrication',
                    'original_bib_text_hash' => GroundTruthText::hash($entry['text']),
                    'original_surname' => $entry['surname'],
                    'original_year' => $entry['year'],
                    'fake_surname' => $fake['surname'],
                    'fake_year' => $fake['year'],
                    'library_collision_checked' => true,
                ],
                'bound_reference_id' => null,
            ];
        }

        // --- Source swap ----------------------------------------------------
        foreach ($swapped as $entryIdx) {
            $occs = array_values(array_filter(
                $doc['occurrences'],
                fn ($o) => $o['entry'] === $entryIdx
            ));
            $occ = $prng->pick($occs);

            // Swap target: a cited, uncorrupted entry other than this one.
            $targets = array_values(array_filter(
                $citedEntryIdxs,
                fn ($i) => $i !== $entryIdx && !in_array($i, $fabricated, true)
                    && !in_array($i, $swapped, true) && !in_array($i, $distorted, true)
            ));
            if ($targets === []) {
                // Fall back to any intact cited entry that isn't this one.
                $targets = array_values(array_filter(
                    $citedEntryIdxs,
                    fn ($i) => $i !== $entryIdx && !in_array($i, $fabricated, true)
                ));
            }
            if ($targets === []) {
                throw new RuntimeException("'{$slug}': no valid swap target for entry {$entryIdx}.");
            }
            $targetIdx = $prng->pick($targets);
            $target = $doc['entries'][$targetIdx];

            $bodyEdits[] = [
                $occ['start'], $occ['end'],
                $this->rewriteCallout($occ, $target['surname'], $target['year']),
            ];
            $occAdjust[$entryIdx]--; // this callout no longer points at its original entry

            $sentence = $this->sentenceAt($doc['body'], $occ['start'], $occ['end']);
            $gtSeq++;
            $gtEntries[] = [
                'gt_id' => sprintf('%s/c%02d', $slug, $gtSeq),
                'label' => 'source_swap',
                'bib_text_normalized' => GroundTruthText::normalise($target['text']),
                'bib_text_hash' => GroundTruthText::hash($target['text']),
                'claim_snippet' => mb_substr(GroundTruthText::normalise($sentence), 0, 120),
                'cited_occurrences' => 1,
                'expected_detection' => 'claim_unsupported',
                'corruption_meta' => [
                    'type' => 'source_swap',
                    'original_bib_text_hash' => GroundTruthText::hash($doc['entries'][$entryIdx]['text']),
                    'original_surname' => $doc['entries'][$entryIdx]['surname'],
                    'swapped_to_surname' => $target['surname'],
                    'swapped_to_year' => $target['year'],
                ],
                'bound_reference_id' => null,
            ];
        }

        // --- Claim distortion ------------------------------------------------
        foreach ($distortionDeck as $entryIdx) {
            if (count($distorted) >= $counts['claim_distortion']) {
                break;
            }
            $occs = array_values(array_filter(
                $doc['occurrences'],
                fn ($o) => $o['entry'] === $entryIdx
            ));
            $result = null;
            foreach ($prng->shuffle($occs) as $occ) {
                $result = $this->distortSentence($doc['body'], $occ, $prng);
                if ($result !== null) {
                    break;
                }
            }
            if ($result === null) {
                continue; // no template applies to this entry's sentences — try the next
            }
            $distorted[] = $entryIdx;
            $occAdjust[$entryIdx]--; // this callout's claim is now the distorted one, not an intact one

            $bodyEdits[] = [$result['start'], $result['end'], $result['replacement']];
            $entry = $doc['entries'][$entryIdx];
            $gtSeq++;
            $gtEntries[] = [
                'gt_id' => sprintf('%s/c%02d', $slug, $gtSeq),
                'label' => 'claim_distortion',
                'bib_text_normalized' => GroundTruthText::normalise($entry['text']),
                'bib_text_hash' => GroundTruthText::hash($entry['text']),
                'claim_snippet' => mb_substr(GroundTruthText::normalise($result['replacement']), 0, 120),
                'cited_occurrences' => 1,
                'expected_detection' => 'claim_unsupported',
                'corruption_meta' => [
                    'type' => 'claim_distortion',
                    'template' => $result['template'],
                    'original_sentence_hash' => GroundTruthText::hash($result['original']),
                ],
                'bound_reference_id' => null,
            ];
        }
        if (count($distorted) < $counts['claim_distortion']) {
            throw new RuntimeException(
                "'{$slug}': only " . count($distorted) . " of {$counts['claim_distortion']} distortions placeable — "
                . 'no template applies to the remaining cited entries. Lower the count or pick a different document.'
            );
        }

        // --- Intact entries (explicit, so denominators are auditable) --------
        foreach ($doc['entries'] as $i => $entry) {
            if (isset($refEdits[$i])) {
                continue; // fabricated — already labelled
            }
            $gtSeq++;
            $gtEntries[] = [
                'gt_id' => sprintf('%s/c%02d', $slug, $gtSeq),
                'label' => 'intact',
                'bib_text_normalized' => GroundTruthText::normalise($entry['text']),
                'bib_text_hash' => GroundTruthText::hash($entry['text']),
                'claim_snippet' => null,
                'cited_occurrences' => max(0, $occCount[$i] + $occAdjust[$i]),
                'expected_detection' => 'pass',
                'corruption_meta' => null,
                'bound_reference_id' => null,
            ];
        }

        $corrupted = $this->applyEdits($doc, $bodyEdits, $refEdits);

        $groundTruth = [
            'book' => $slug,
            'generator' => 'CitationCorruptor v1',
            'seed' => (int) $spec['seed'],
            'entries' => $gtEntries,
            'binding' => ['bound_at' => null, 'book_id' => null, 'unmatched' => []],
        ];

        $corruptedRel = $book['study_file'] ?? "sources/{$slug}/corrupted.md";
        if (!$dryRun) {
            $corruptedPath = $manifest->path($corruptedRel);
            @mkdir(dirname($corruptedPath), 0775, true);
            file_put_contents($corruptedPath, $corrupted);
            $manifest->saveGroundTruth($book, $groundTruth);
        }

        return [
            'slug' => $slug,
            'entries' => count($doc['entries']),
            'cited_entries' => count($citedEntryIdxs),
            'occurrences' => count($doc['occurrences']),
            'fabricated' => count($fabricated),
            'swapped' => count($swapped),
            'distorted' => count($distorted),
            'corrupted_md' => $corrupted,
            'ground_truth' => $groundTruth,
        ];
    }

    /**
     * Skeleton ground truth for control / retracted books: every parsed
     * bibliography entry gets the manifest's default label, ready for manual
     * verification and hand-editing. No corruption, no file rewrite.
     */
    public function skeleton(CorpusManifest $manifest, array $book, bool $dryRun = false): array
    {
        $slug = $book['slug'];
        $sourcePath = $manifest->studyFile($book);
        if (!is_file($sourcePath)) {
            throw new RuntimeException("Study file missing for '{$slug}': {$sourcePath}");
        }
        if (str_ends_with(strtolower($sourcePath), '.html')) {
            // HTML sources (numbered/Vancouver books) get their skeleton from
            // the IMPORTED rows instead — parsing HTML for a reference list
            // would just re-derive, less reliably, what the import produced.
            return $this->skeletonFromImportedRows($manifest, $book, $dryRun);
        }
        $markdown = (string) file_get_contents($sourcePath);
        if (!preg_match(self::REFS_HEADING, $markdown)) {
            // Footnote-style document (Chicago): no references section, one
            // [^N]: definition per citation. Corruption is unsupported for
            // these (hand-label instead), but the skeleton can still be
            // generated from the definitions.
            return $this->skeletonFromFootnotes($manifest, $book, $markdown, $dryRun);
        }
        $doc = $this->parse($markdown, $slug, strict: false);
        $label = $book['default_label'] ?? 'intact';

        $occCount = array_fill(0, count($doc['entries']), 0);
        foreach ($doc['occurrences'] as $occ) {
            $occCount[$occ['entry']]++;
        }

        $gtEntries = [];
        foreach ($doc['entries'] as $i => $entry) {
            $gtEntries[] = [
                'gt_id' => sprintf('%s/c%02d', $slug, $i + 1),
                'label' => $label,
                'bib_text_normalized' => GroundTruthText::normalise($entry['text']),
                'bib_text_hash' => GroundTruthText::hash($entry['text']),
                'claim_snippet' => null,
                'cited_occurrences' => $entry['surname'] === null ? null : $occCount[$i],
                'expected_detection' => in_array($label, CorpusManifest::NEGATIVE_LABELS, true) ? 'pass' : 'flag',
                'corruption_meta' => null,
                'bound_reference_id' => null,
            ];
        }

        $groundTruth = [
            'book' => $slug,
            'generator' => 'CitationCorruptor v1 (skeleton)',
            'seed' => null,
            'entries' => $gtEntries,
            'binding' => ['bound_at' => null, 'book_id' => null, 'unmatched' => []],
        ];

        if (!$dryRun) {
            $manifest->saveGroundTruth($book, $groundTruth);
        }

        return [
            'slug' => $slug,
            'entries' => count($doc['entries']),
            'occurrences' => count($doc['occurrences']),
            'warnings' => $doc['warnings'],
            'ground_truth' => $groundTruth,
        ];
    }

    /**
     * Skeleton built from the imported study book's own bibliography /
     * footnote rows — used when the source is HTML. Requires the book to be
     * imported first (citation:study:import runs this before binding).
     */
    private function skeletonFromImportedRows(CorpusManifest $manifest, array $book, bool $dryRun): array
    {
        $slug = $book['slug'];
        $bookId = $manifest->bookIdFor($slug);
        $label = $book['default_label'] ?? 'intact';

        $rows = DB::connection('pgsql_admin')->table('bibliography')->where('book', $bookId)->get(['content']);
        $source = 'bibliography';
        if ($rows->isEmpty()) {
            $rows = DB::connection('pgsql_admin')->table('footnotes')->where('book', $bookId)->get(['content']);
            $source = 'footnotes';
        }
        if ($rows->isEmpty()) {
            throw new RuntimeException(
                "'{$slug}': HTML source needs the book imported before its skeleton can be built "
                . "(no bibliography/footnote rows for {$bookId})."
            );
        }

        $gtEntries = [];
        foreach ($rows as $i => $row) {
            $gtEntries[] = [
                'gt_id' => sprintf('%s/c%02d', $slug, $i + 1),
                'label' => $label,
                'bib_text_normalized' => GroundTruthText::normalise($row->content),
                'bib_text_hash' => GroundTruthText::hash($row->content),
                'claim_snippet' => null,
                'cited_occurrences' => null,
                'expected_detection' => in_array($label, CorpusManifest::NEGATIVE_LABELS, true) ? 'pass' : 'flag',
                'corruption_meta' => null,
                'bound_reference_id' => null,
            ];
        }

        $groundTruth = [
            'book' => $slug,
            'generator' => "CitationCorruptor v1 (skeleton from imported {$source} rows)",
            'seed' => null,
            'entries' => $gtEntries,
            'binding' => ['bound_at' => null, 'book_id' => null, 'unmatched' => []],
        ];

        if (!$dryRun) {
            $manifest->saveGroundTruth($book, $groundTruth);
        }

        return [
            'slug' => $slug,
            'entries' => count($gtEntries),
            'occurrences' => 0,
            'warnings' => ["skeleton derived from imported {$source} rows (HTML source)"],
            'ground_truth' => $groundTruth,
        ];
    }

    /**
     * Skeleton for footnote-style (Chicago) documents: one ground-truth entry
     * per [^N]: definition. cited_occurrences stays null — a footnote can be
     * commentary rather than a citation (the pipeline classifies that later
     * via is_citation), so occurrence-based orphan detection would produce
     * false misses. Hand-verification should DELETE entries whose footnote is
     * not a citation.
     */
    private function skeletonFromFootnotes(CorpusManifest $manifest, array $book, string $markdown, bool $dryRun): array
    {
        $slug = $book['slug'];
        $label = $book['default_label'] ?? 'intact';

        // A definition runs from "[^N]:" to the next definition or a
        // non-indented blank-separated block.
        preg_match_all('/^\[\^([^\]]+)\]:[ \t]*((?:.+(?:\n(?![ \t]*\[\^)[ \t]+.+)*)?)/m', $markdown, $defs, PREG_SET_ORDER);
        if ($defs === []) {
            throw new RuntimeException(
                "'{$slug}': no references heading AND no [^N]: footnote definitions — cannot build a skeleton."
            );
        }

        $gtEntries = [];
        foreach ($defs as $i => $def) {
            $text = trim(preg_replace('/\s+/', ' ', $def[2]));
            if ($text === '') {
                continue;
            }
            $gtEntries[] = [
                'gt_id' => sprintf('%s/c%02d', $slug, $i + 1),
                'label' => $label,
                'bib_text_normalized' => GroundTruthText::normalise($text),
                'bib_text_hash' => GroundTruthText::hash($text),
                'claim_snippet' => null,
                'cited_occurrences' => null,
                'expected_detection' => in_array($label, CorpusManifest::NEGATIVE_LABELS, true) ? 'pass' : 'flag',
                'corruption_meta' => null,
                'bound_reference_id' => null,
                'footnote_marker' => $def[1],
            ];
        }

        $groundTruth = [
            'book' => $slug,
            'generator' => 'CitationCorruptor v1 (footnote skeleton)',
            'seed' => null,
            'entries' => $gtEntries,
            'binding' => ['bound_at' => null, 'book_id' => null, 'unmatched' => []],
        ];

        if (!$dryRun) {
            $manifest->saveGroundTruth($book, $groundTruth);
        }

        return [
            'slug' => $slug,
            'entries' => count($gtEntries),
            'occurrences' => 0,
            'warnings' => ['footnote-style document: delete ground-truth entries for footnotes that are commentary, not citations'],
            'ground_truth' => $groundTruth,
        ];
    }

    // ------------------------------------------------------------------ parse

    /**
     * Parse markdown into body + bibliography entries + in-text occurrences.
     *
     * Strict mode (the corruption path) hard-fails on any entry whose
     * surname+year can't be extracted — corruption needs them. Lenient mode
     * (the skeleton path) keeps such entries with null surname/year and lists
     * them in 'warnings': binding is by TEXT, the surname only drives
     * occurrence counting, and skeleton labels are hand-verified anyway.
     *
     * @return array{body: string, preRefs: string, refsHeading: string, postRefs: string,
     *               entries: array[], occurrences: array[], warnings: string[]}
     */
    public function parse(string $markdown, string $slug, bool $strict = true): array
    {
        if (!preg_match(self::REFS_HEADING, $markdown, $m, PREG_OFFSET_CAPTURE)) {
            throw new RuntimeException("'{$slug}': no references/bibliography heading found — document excluded.");
        }
        $headingStart = $m[0][1];
        $headingLine = $m[0][0];
        $refsStart = $headingStart + strlen($headingLine);

        $body = substr($markdown, 0, $headingStart);
        $refsSection = substr($markdown, $refsStart);

        // A later heading ends the references section (appendices etc.).
        $postRefs = '';
        if (preg_match('/^#{1,6}\s+\S/m', $refsSection, $hm, PREG_OFFSET_CAPTURE, 1)) {
            $postRefs = substr($refsSection, $hm[0][1]);
            $refsSection = substr($refsSection, 0, $hm[0][1]);
        }

        // One entry per non-empty paragraph block.
        $blocks = preg_split('/\n\s*\n/', trim($refsSection));
        $entries = [];
        $warnings = [];
        foreach ($blocks as $block) {
            $text = trim($block);
            if ($text === '') {
                continue;
            }
            if (preg_match('/^[-*_\s]+$/', $text)) {
                continue; // horizontal rule, not an entry
            }
            if (str_starts_with($text, '[^')) {
                continue; // trailing footnote definition, not an entry
            }
            $surname = $this->leadSurname($text);
            $year = preg_match('/\b(' . self::YEAR . ')\b/', $text, $ym) ? $ym[1] : null;
            if ($surname === null || $year === null) {
                if ($strict) {
                    throw new RuntimeException(
                        "'{$slug}': cannot parse a surname+year from reference entry: "
                        . mb_substr($text, 0, 80) . '… — document excluded.'
                    );
                }
                $warnings[] = 'unparseable surname/year (occurrences not counted): ' . mb_substr($text, 0, 70) . '…';
                $entries[] = ['text' => $text, 'surname' => null, 'year' => null];
                continue;
            }
            $entries[] = ['text' => $text, 'surname' => $surname, 'year' => $year];
        }
        if ($entries === []) {
            throw new RuntimeException("'{$slug}': references section has no entries — document excluded.");
        }

        $occurrences = $this->findOccurrences($body, $entries);
        if ($occurrences === [] && $strict) {
            // Corruption needs author-date callouts to rewrite. Skeletons
            // don't: numbered/Vancouver styles cite as [N], occurrence counts
            // are advisory there, and binding is by text.
            throw new RuntimeException("'{$slug}': no in-text author-date citations matched any reference entry — document excluded.");
        }
        if ($occurrences === []) {
            $warnings[] = 'no author-date callouts found (numbered citation style?) — occurrence counts not recorded';
        }

        return [
            'body' => $body,
            'refsHeading' => $headingLine,
            'postRefs' => $postRefs,
            'entries' => $entries,
            'occurrences' => $occurrences,
            'warnings' => $warnings,
        ];
    }

    /**
     * Every author-date callout in the body matched to its entry.
     * Kinds: 'parenthetical' (a "Surname …, Year" segment inside parens,
     * span = the segment) and 'narrative' ("Surname (Year)", span = the whole
     * construct).
     *
     * @return array[] each {entry:int, kind:string, start:int, end:int, text:string}
     */
    private function findOccurrences(string $body, array $entries): array
    {
        $occurrences = [];

        foreach ($entries as $idx => $entry) {
            if ($entry['surname'] === null) {
                continue; // lenient-mode entry — no occurrence matching possible
            }
            $surname = preg_quote($entry['surname'], '/');
            $year = preg_quote($entry['year'], '/');

            // Parenthetical: "(... Smith et al., 2019 ...)" — match the
            // segment between ; or ( boundaries so multi-cite groups edit
            // cleanly per-segment.
            $seg = '/\b' . $surname . '\b[^;()\n]{0,60}?\b' . $year . '\b/u';
            if (preg_match_all('/\(([^()\n]*)\)/u', $body, $parens, PREG_OFFSET_CAPTURE)) {
                foreach ($parens[1] as $p) {
                    [$inner, $innerStart] = $p;
                    if (preg_match($seg, $inner, $sm, PREG_OFFSET_CAPTURE)) {
                        $occurrences[] = [
                            'entry' => $idx,
                            'kind' => 'parenthetical',
                            'start' => $innerStart + $sm[0][1],
                            'end' => $innerStart + $sm[0][1] + strlen($sm[0][0]),
                            'text' => $sm[0][0],
                        ];
                    }
                }
            }

            // Narrative: "Smith (2019)" / "Smith et al. (2019, p. 4)".
            $narr = '/\b' . $surname . '\b(?:\s+et\s+al\.?)?\s*\(\s*' . $year . '\b[^)]*\)/u';
            if (preg_match_all($narr, $body, $nm, PREG_OFFSET_CAPTURE)) {
                foreach ($nm[0] as $n) {
                    $occurrences[] = [
                        'entry' => $idx,
                        'kind' => 'narrative',
                        'start' => $n[1],
                        'end' => $n[1] + strlen($n[0]),
                        'text' => $n[0],
                    ];
                }
            }
        }

        // Deduplicate overlapping matches (a narrative match contains a year
        // that a parenthetical scan may also have caught) and sort by position.
        usort($occurrences, fn ($a, $b) => $a['start'] <=> $b['start']);
        $deduped = [];
        foreach ($occurrences as $occ) {
            $last = end($deduped);
            if ($last !== false && $occ['start'] < $last['end']) {
                continue;
            }
            $deduped[] = $occ;
        }
        return $deduped;
    }

    private function leadSurname(string $entryText): ?string
    {
        // Last name-like word before the first comma/paren. "Name-like" means
        // it contains a lowercase letter, so bare initials don't qualify —
        // covers APA "Smith, J.", Sage-Harvard "Abrahamsen R," (surname then
        // initials, no comma), corporate authors ("Open Science Collaboration"
        // → "Collaboration", "Agence France-Presse" → "France-Presse"), and
        // particled names ("van der Berg" → "Berg"; callouts still match
        // because the occurrence regex looks for \bBerg\b inside the segment).
        $head = trim(preg_replace('/^[\*_\[\]#>\s-]+/u', '', $entryText));
        $beforeComma = preg_split('/[,(]/u', $head)[0] ?? '';
        $words = preg_split('/\s+/u', trim($beforeComma));
        $surname = null;
        $acronym = null;
        foreach ($words as $word) {
            $word = trim($word, '.');
            if (preg_match('/^\p{Lu}[\p{L}\p{N}\'-]*\p{Ll}[\p{L}\p{N}\'-]*$/u', $word)) {
                $surname = $word; // digits allowed for outlet names: News18, France24
            } elseif (preg_match('/^\p{Lu}{2,}$/u', $word)) {
                $acronym = $word; // corporate authors cited by acronym: ANI, BBC, OECD
            }
        }
        return $surname ?? $acronym;
    }

    // ------------------------------------------------------------- corruption

    private function resolveCounts(array $spec, int $entryCount): array
    {
        $counts = ['fabrication' => 0, 'source_swap' => 0, 'claim_distortion' => 0];
        if (isset($spec['counts'])) {
            foreach ($counts as $key => $_) {
                $counts[$key] = max(0, (int) ($spec['counts'][$key] ?? 0));
            }
        } elseif (isset($spec['rates'])) {
            foreach ($counts as $key => $_) {
                $rate = (float) ($spec['rates'][$key] ?? 0);
                $counts[$key] = (int) round($rate * $entryCount);
            }
        }
        if (array_sum($counts) === 0) {
            throw new RuntimeException('Corruption spec produces zero corruptions (set counts or rates).');
        }
        return $counts;
    }

    private function generateFakeReference(StudyPrng $prng, array $originalEntry): array
    {
        $surname = $prng->pick(self::FAKE_SURNAMES);
        $initials = $prng->pick(self::FAKE_INITIALS);
        $title = $prng->pick(self::FAKE_TITLES);
        $journal = $prng->pick(self::FAKE_JOURNALS);
        $yearBase = (int) substr($originalEntry['year'], 0, 4);
        $year = (string) max(1950, $yearBase - 3 + $prng->nextInt(7));
        $volume = 5 + $prng->nextInt(40);
        $issue = 1 + $prng->nextInt(4);
        $firstPage = 20 + $prng->nextInt(300);
        $lastPage = $firstPage + 15 + $prng->nextInt(20);

        $text = "{$surname}, {$initials} ({$year}). {$title}. *{$journal}*, {$volume}({$issue}), {$firstPage}–{$lastPage}.";
        return ['surname' => $surname, 'year' => $year, 'title' => $title, 'text' => $text];
    }

    /**
     * A fabricated title colliding with a real local library row would let
     * Wave 3 "resolve" the fake — invalidating the ground truth. Hard-stop at
     * corpus build time.
     */
    private function guardFakeAgainstLibrary(array $fake, string $slug): void
    {
        try {
            $hit = DB::connection('pgsql_admin')
                ->table('library')
                ->where('title', 'ILIKE', '%' . $fake['title'] . '%')
                ->exists();
        } catch (\Throwable) {
            return; // no DB in this context (e.g. pure --check run in CI) — the pool is curated
        }
        if ($hit) {
            throw new RuntimeException(
                "'{$slug}': fabricated title collides with a local library row: {$fake['title']} — change the spec seed."
            );
        }
    }

    private function rewriteCallout(array $occ, string $surname, string $year): string
    {
        if ($occ['kind'] === 'parenthetical') {
            return "{$surname}, {$year}";
        }
        // Narrative: preserve any trailing locator (", p. 4") inside the parens.
        if (preg_match('/\(\s*' . self::YEAR . '\b([^)]*)\)/u', $occ['text'], $m)) {
            return "{$surname} ({$year}{$m[1]})";
        }
        return "{$surname} ({$year})";
    }

    /** Distortion templates; returns null when none applies to the sentence. */
    private function distortSentence(string $body, array $occ, StudyPrng $prng): ?array
    {
        [$sentStart, $sentEnd] = $this->sentenceBounds($body, $occ['start'], $occ['end']);
        $sentence = substr($body, $sentStart, $sentEnd - $sentStart);

        $templates = $prng->shuffle(['direction_reversal', 'number_inflation', 'negation']);
        foreach ($templates as $template) {
            $rewritten = match ($template) {
                'direction_reversal' => $this->reverseDirection($sentence),
                'number_inflation' => $this->inflateNumber($sentence, $occ, $sentStart),
                'negation' => $this->negate($sentence),
            };
            if ($rewritten !== null && $rewritten !== $sentence) {
                return [
                    'start' => $sentStart,
                    'end' => $sentEnd,
                    'replacement' => $rewritten,
                    'original' => $sentence,
                    'template' => $template,
                ];
            }
        }
        return null;
    }

    private function reverseDirection(string $sentence): ?string
    {
        $pairs = [
            'increase' => 'decrease', 'increased' => 'decreased', 'increases' => 'decreases', 'increasing' => 'decreasing',
            'higher' => 'lower', 'rise' => 'fall', 'rose' => 'fell', 'grew' => 'shrank', 'growth' => 'decline',
            'more' => 'less', 'greater' => 'smaller', 'improved' => 'worsened', 'positive' => 'negative',
            'gains' => 'losses', 'expanded' => 'contracted', 'strengthened' => 'weakened',
        ];
        foreach ($pairs as $from => $to) {
            $out = preg_replace('/\b' . $from . '\b/', $to, $sentence, 1, $count);
            if ($count > 0) {
                return $out;
            }
            // Also try the reverse direction of the pair.
            $out = preg_replace('/\b' . $to . '\b/', $from, $sentence, 1, $count);
            if ($count > 0) {
                return $out;
            }
        }
        return null;
    }

    private function inflateNumber(string $sentence, array $occ, int $sentStart): ?string
    {
        // First standalone number NOT inside the citation callout and not a year.
        $calloutStart = $occ['start'] - $sentStart;
        $calloutEnd = $occ['end'] - $sentStart;
        if (!preg_match_all('/\b\d+(?:\.\d+)?\b/', $sentence, $m, PREG_OFFSET_CAPTURE)) {
            return null;
        }
        foreach ($m[0] as [$num, $off]) {
            if ($off >= $calloutStart && $off < $calloutEnd) {
                continue;
            }
            if (preg_match('/^(?:1[89]|20)\d{2}$/', $num)) {
                continue;
            }
            $inflated = str_contains($num, '.')
                ? rtrim(rtrim(number_format((float) $num * 10, 2, '.', ''), '0'), '.')
                : (string) ((int) $num * 10);
            return substr($sentence, 0, $off) . $inflated . substr($sentence, $off + strlen($num));
        }
        return null;
    }

    private function negate(string $sentence): ?string
    {
        $out = preg_replace('/\b(is|are|was|were)\b(?!\s+not\b)/', '$1 not', $sentence, 1, $count);
        if ($count > 0) {
            return $out;
        }
        $out = preg_replace('/\b(shows?|showed|demonstrates?|demonstrated|finds?|found|suggests?|suggested|indicates?|indicated)\s+that\b/', '$1 no evidence that', $sentence, 1, $count);
        return $count > 0 ? $out : null;
    }

    // ------------------------------------------------------------- text utils

    private function sentenceBounds(string $body, int $start, int $end): array
    {
        // Backwards to sentence start: after ". " / "? " / "! " / newline.
        $s = $start;
        while ($s > 0) {
            $ch = $body[$s - 1];
            if ($ch === "\n") {
                break;
            }
            if (in_array($ch, ['.', '?', '!'], true) && ($body[$s] ?? '') === ' ') {
                $s++;
                break;
            }
            $s--;
        }
        // Forwards to sentence end: the first ./?/! followed by space/newline/EOF.
        $len = strlen($body);
        $e = $end;
        while ($e < $len) {
            $ch = $body[$e];
            if (in_array($ch, ['.', '?', '!'], true)) {
                $next = $body[$e + 1] ?? '';
                if ($next === '' || $next === ' ' || $next === "\n") {
                    $e++;
                    break;
                }
            }
            if ($ch === "\n") {
                break;
            }
            $e++;
        }
        return [$s, $e];
    }

    private function sentenceAt(string $body, int $start, int $end): string
    {
        [$s, $e] = $this->sentenceBounds($body, $start, $end);
        return substr($body, $s, $e - $s);
    }

    private function applyEdits(array $doc, array $bodyEdits, array $refEdits): string
    {
        // Apply body edits back-to-front so earlier offsets stay valid.
        usort($bodyEdits, fn ($a, $b) => $b[0] <=> $a[0]);
        $body = $doc['body'];
        $prevStart = PHP_INT_MAX;
        foreach ($bodyEdits as [$start, $end, $replacement]) {
            if ($end > $prevStart) {
                throw new RuntimeException('Overlapping body edits — corruption spec too dense for this document.');
            }
            $prevStart = $start;
            $body = substr($body, 0, $start) . $replacement . substr($body, $end);
        }

        $refBlocks = [];
        foreach ($doc['entries'] as $i => $entry) {
            $refBlocks[] = $refEdits[$i] ?? $entry['text'];
        }

        $out = $body . $doc['refsHeading'] . "\n\n" . implode("\n\n", $refBlocks) . "\n";
        if ($doc['postRefs'] !== '') {
            $out .= "\n" . $doc['postRefs'];
        }
        return $out;
    }
}
