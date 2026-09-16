<?php

namespace App\Services\CitationStudy;

use Illuminate\Support\Facades\DB;
use Symfony\Component\Process\Exception\ProcessFailedException;
use Symfony\Component\Process\Process;

/**
 * Pre-labelling triage for a hand-labelled corpus book.
 *
 * Hand-labelling asks "is this citation sound?", but a ground-truth entry can
 * only answer that if its TEXT is what the author actually wrote. A converted
 * book fails that precondition in two ways the labeller cannot see by eye:
 *
 *  - OCR damage — the conversion invented words ("Gentelink" for "Centrelink",
 *    "Minelle Hildebrandt" for "Mireille"). Labelling those as bad citations
 *    makes the study measure our own OCR, not the citation checker.
 *  - Non-citations — bare "Ibid.", "See as examples, ED75", "Above n (41)".
 *    The footnote skeleton emits one entry per [^N]: definition, but a footnote
 *    can be commentary; these can never resolve to a source, so left labelled
 *    'intact' they pad the negative pool with unscoreable rows.
 *
 * Two witnesses settle both, when available:
 *  - the source PDF's own text layer (via pdftotext) — a token that appears
 *    NOWHERE in it was invented by the converter;
 *  - the document's own reference list, if it ships one (many reports repeat
 *    their citations in an appendix table) — a second rendering of the same
 *    citation, which also catches corruption that landed on a real word
 *    ("Problems" for "Freedoms", "Whitefoot" for "Whiteford").
 *
 * Read-only: it reports a status per entry and never writes ground truth.
 */
class GroundTruthTriage
{
    public const CLEAN = 'clean';

    /**
     * The converter changed what the citation SAYS — an invented word
     * ("Gentelink") or one real word for another ("Problems" for "Freedoms",
     * "Cals" for "Cass"). Not labellable: the text is not the author's.
     */
    public const OCR_GARBLED = 'ocr_garbled';

    /**
     * Only whitespace moved — "ju stice", "craw ford", "th enetherlands",
     * "marketdriven". The wording is intact and recoverable, so the entry is
     * still labellable; worth knowing because it can depress source matching.
     */
    public const OCR_SPACING = 'ocr_spacing';

    /**
     * An "Ibid." / short-form note the pipeline LINKED to its antecedent work
     * (match_method = short_form_antecedent). It is a real, scoreable citation
     * — its ground-truth label is whatever the antecedent's label is, and it
     * inherits the antecedent's resolution, so a not-found verdict here is the
     * antecedent's failure, not this note's.
     */
    public const SHORT_FORM_LINKED = 'short_form_linked';

    /**
     * An "Ibid." / short-form note whose antecedent could NOT be determined
     * (the chain broke on an earlier unknown). Nothing can be verified about
     * it on its own, so it cannot carry a scored label.
     */
    public const SHORT_FORM_UNLINKED = 'short_form_unlinked';

    /** A pointer to the document's own internal evidence ("See ED75, ED76"). */
    public const NOT_A_CITATION = 'not_a_citation';

    public const NO_WITNESS = 'no_witness';

    /**
     * A corruption the STUDY injected (synthetic arm). Its text is absent from
     * the source PDF by design, which is the one case where "not in the
     * document" is not a conversion defect — reported separately so a seeded
     * fabrication is never mistaken for OCR damage.
     */
    public const SEEDED = 'seeded_corruption';

    /**
     * Fallback shape check for short-form notes, used ONLY when the book has
     * not been imported and scanned yet. The pipeline's own classifier
     * (footnotes.llm_metadata.type) is the authority whenever it is available —
     * it links "Ibid." to its antecedent work, which this regex cannot do.
     */
    private const SHORT_FORM_RE = '/^(ibid|id\b|above n|see above|as above|n \d+)/';

    /** Pointers into the document's own evidence register, not external works. */
    private const POINTER_RE = '/^(see as examples?|see ed\d|ed\d)/';

    /** Tokens shorter than this are too collision-prone to judge as invented. */
    private const MIN_TOKEN_LEN = 4;

    /** Below this token overlap, a reference-list row is a different citation. */
    private const WITNESS_MATCH_FLOOR = 0.60;

    /**
     * A counterpart this similar is the SAME citation, so its word differences
     * are conversion damage. Below it, differences are just a different work.
     */
    private const WITNESS_SAME_CITATION = 0.75;

    /**
     * OCR substitutes a few words; a wholly different passage is a mismatched
     * counterpart. Cap the share of the entry a diff may rewrite.
     */
    private const WITNESS_MAX_SUBSTITUTED_SHARE = 0.30;

    /**
     * @return array{
     *   slug: string,
     *   witnesses: array{pdf: ?string, reference_rows: int},
     *   counts: array<string,int>,
     *   entries: list<array<string,mixed>>
     * }
     */
    public function triage(CorpusManifest $manifest, array $book): array
    {
        $groundTruth = $manifest->loadGroundTruth($book);
        $sourcePath = $manifest->studyFile($book);
        $markdown = is_file($sourcePath) ? (string) file_get_contents($sourcePath) : '';

        $pdfPath = $this->pdfPathFor($book);
        $pdfText = $pdfPath !== null ? $this->extractPdfText($pdfPath) : null;
        $pdfIndex = $pdfText !== null ? $this->indexWitness($pdfText) : null;
        $referenceRows = $this->referenceListRows($markdown);

        $pipelineTypes = $this->pipelineFootnoteTypes($manifest, $book);

        $entries = [];
        $counts = [
            self::CLEAN => 0,
            self::OCR_SPACING => 0,
            self::OCR_GARBLED => 0,
            self::SHORT_FORM_LINKED => 0,
            self::SHORT_FORM_UNLINKED => 0,
            self::NOT_A_CITATION => 0,
            self::SEEDED => 0,
            self::NO_WITNESS => 0,
        ];

        foreach ($groundTruth['entries'] as $entry) {
            $text = (string) ($entry['bib_text_normalized'] ?? '');
            $row = [
                'gt_id' => $entry['gt_id'] ?? null,
                'footnote_marker' => $entry['footnote_marker'] ?? null,
                'label' => $entry['label'] ?? null,
                'text' => $text,
                'invented_tokens' => [],
                'witness_text' => null,
                'witness_score' => null,
                'witness_diff' => null,
                'antecedent' => null,
                'classified_by' => null,
                'status' => self::CLEAN,
            ];

            $shortForm = $this->classifyShortForm($entry, $text, $pipelineTypes);
            if ($shortForm !== null) {
                $row['status'] = $shortForm['status'];
                $row['antecedent'] = $shortForm['antecedent'];
                $row['classified_by'] = $shortForm['by'];
                $counts[$shortForm['status']]++;
                $entries[] = $row;
                continue;
            }

            // Seeded corruptions are absent from the source document on purpose.
            if (!empty($entry['corruption_meta'])) {
                $row['status'] = self::SEEDED;
                $counts[self::SEEDED]++;
                $entries[] = $row;
                continue;
            }

            if ($pdfIndex === null) {
                $row['status'] = self::NO_WITNESS;
            } else {
                $row['invented_tokens'] = $this->inventedTokens($text, $pdfIndex);
                if ($row['invented_tokens'] !== []) {
                    $row['status'] = self::OCR_GARBLED;
                }
            }

            // Second witness: the document's own reference list. A near-match
            // that still differs word-for-word is corruption the token test
            // cannot see (the substitute is itself a real word).
            [$witness, $score] = $this->bestReferenceRow($text, $referenceRows);
            if ($witness !== null) {
                $row['witness_text'] = $witness;
                $row['witness_score'] = round($score, 3);
                $diff = $this->wordDiff($text, $witness);
                $substitutions = array_values(array_filter($diff, fn ($d) => $d['from'] !== '' && $d['to'] !== ''));
                if ($substitutions !== []) {
                    $row['witness_diff'] = $substitutions;

                    // Promote to damaged only when the counterpart is clearly
                    // the SAME citation and the rewrite is local. Otherwise the
                    // diff is advisory — reported for the labeller to read, not
                    // trusted as evidence of corruption.
                    $substituted = 0;
                    foreach ($substitutions as $d) {
                        $substituted += count(array_filter(explode(' ', $d['from'])));
                    }
                    $entryTokens = max(1, count(array_filter(explode(' ', $text))));
                    $localised = ($substituted / $entryTokens) <= self::WITNESS_MAX_SUBSTITUTED_SHARE;

                    if ($row['status'] === self::CLEAN
                        && $score >= self::WITNESS_SAME_CITATION
                        && $localised
                    ) {
                        // Whitespace-only damage leaves the wording intact, so
                        // it does not disqualify the entry from labelling.
                        $row['status'] = $this->isSpacingOnly($substitutions)
                            ? self::OCR_SPACING
                            : self::OCR_GARBLED;
                    }
                }
            }

            $counts[$row['status']]++;
            $entries[] = $row;
        }

        return [
            'slug' => $book['slug'],
            'witnesses' => [
                'pdf' => $pdfPath,
                'reference_rows' => count($referenceRows),
            ],
            'counts' => $counts,
            'entries' => $entries,
        ];
    }

    /**
     * The pipeline's OWN classification of each footnote, keyed by footnoteId
     * (= a ground-truth entry's bound_reference_id).
     *
     * "Is this footnote a citation, and what does it point at" is already
     * decided by CitationScanBibliographyJob: it types each note (ibid /
     * short-form / pointer / …) and links short forms to their antecedent
     * full citation (match_method = short_form_antecedent), substituting the
     * antecedent's metadata. Re-deciding that here from the text would be a
     * second, worse definition of the same question.
     *
     * @return array<string, array{type: ?string, short_form_of: ?string, match_method: ?string}>
     */
    private function pipelineFootnoteTypes(CorpusManifest $manifest, array $book): array
    {
        $bookId = $manifest->bookIdFor($book['slug']);
        try {
            $rows = DB::connection('pgsql_admin')->table('footnotes')
                ->where('book', $bookId)
                ->get(['footnoteId', 'llm_metadata', 'match_method']);
        } catch (\Throwable) {
            return []; // not imported yet (or no DB) — callers fall back to shape
        }

        $out = [];
        foreach ($rows as $row) {
            $meta = json_decode((string) ($row->llm_metadata ?? ''), true);
            $meta = is_array($meta) ? $meta : [];
            $out[$row->footnoteId] = [
                'type' => $meta['type'] ?? null,
                'short_form_of' => $meta['short_form_of'] ?? null,
                'match_method' => $row->match_method ?? null,
            ];
        }
        return $out;
    }

    /**
     * Decide whether an entry is a short-form/pointer note rather than a
     * citation in its own right. Returns null for ordinary citations.
     *
     * @param array<string, array{type: ?string, short_form_of: ?string, match_method: ?string}> $pipelineTypes
     * @return array{status: string, antecedent: ?string, by: string}|null
     */
    private function classifyShortForm(array $entry, string $text, array $pipelineTypes): ?array
    {
        $meta = $pipelineTypes[$entry['bound_reference_id'] ?? ''] ?? null;

        if ($meta !== null && $meta['type'] !== null) {
            if ($meta['type'] === 'pointer') {
                return ['status' => self::NOT_A_CITATION, 'antecedent' => null, 'by' => 'pipeline'];
            }
            if (in_array($meta['type'], ['ibid', 'short-form'], true)) {
                // Still typed as a short form AFTER the linking pass ran means
                // no antecedent was found — the pipeline replaces the type with
                // the antecedent's when it links one.
                return [
                    'status' => self::SHORT_FORM_UNLINKED,
                    'antecedent' => null,
                    'by' => 'pipeline',
                ];
            }
            if ($meta['match_method'] === 'short_form_antecedent' || $meta['short_form_of'] !== null) {
                return [
                    'status' => self::SHORT_FORM_LINKED,
                    'antecedent' => $meta['short_form_of'],
                    'by' => 'pipeline',
                ];
            }
            return null; // pipeline says it is an ordinary citation
        }

        // Not imported/scanned: fall back to the note's shape.
        if ($text === '' || preg_match(self::SHORT_FORM_RE, $text)) {
            return ['status' => self::SHORT_FORM_UNLINKED, 'antecedent' => null, 'by' => 'shape'];
        }
        if (preg_match(self::POINTER_RE, $text)) {
            return ['status' => self::NOT_A_CITATION, 'antecedent' => null, 'by' => 'shape'];
        }
        return null;
    }

    // ------------------------------------------------------------- witnesses

    private function pdfPathFor(array $book): ?string
    {
        $sourceBookId = $book['provenance']['source_book_id'] ?? null;
        if (!is_string($sourceBookId) || $sourceBookId === '') {
            return null;
        }
        $path = base_path("resources/markdown/{$sourceBookId}/original.pdf");
        return is_file($path) ? $path : null;
    }

    private function extractPdfText(string $pdfPath): ?string
    {
        try {
            $process = new Process(['pdftotext', '-layout', $pdfPath, '-']);
            $process->setTimeout(120);
            $process->run();
            if (!$process->isSuccessful()) {
                return null;
            }
            $out = $process->getOutput();
            return $out === '' ? null : $out;
        } catch (ProcessFailedException|\Throwable) {
            return null; // pdftotext absent — caller reports NO_WITNESS
        }
    }

    /**
     * Rows of the document's OWN reference-list table, if it ships one.
     *
     * Scoped to the table under a reference-list heading — NOT every long table
     * row in the document. Unscoped, a glossary or evidence table supplies
     * spurious counterparts: two citations of the same government department
     * share so much boilerplate that a wrong row still scores highly, and the
     * resulting diff invents corruption that isn't there.
     *
     * @return list<string> normalised row texts
     */
    private function referenceListRows(string $markdown): array
    {
        if ($markdown === '') {
            return [];
        }
        $lines = preg_split('/\R/', $markdown) ?: [];
        $rows = [];
        $inSection = false;

        foreach ($lines as $line) {
            $line = trim($line);

            if (preg_match('/^#{1,6}\s*(.+)$/', $line, $m)) {
                // A heading either opens the reference list or closes it.
                $inSection = $this->namesReferenceList($m[1]);
                continue;
            }
            // A table caption. The SAME caption repeats once per page of a long
            // table ("Table 58: H Reference List" x6 in the Deloitte report), so
            // a caption naming the reference list is a page break, not the end —
            // closing on the first one truncated 141 rows to 14. A caption naming
            // something else means a different table has started.
            if ($inSection && preg_match('/^Table\s+\d+\s*:\s*(.*)$/i', $line, $m)) {
                $inSection = $this->namesReferenceList($m[1]);
                continue;
            }
            if (!$inSection || $line === '' || $line[0] !== '|' || str_contains($line, '---')) {
                continue;
            }

            $cells = array_map('trim', explode('|', trim($line, '|')));
            $last = end($cells);
            if (!is_string($last) || mb_strlen($last) < 40) {
                continue;
            }
            $norm = GroundTruthText::normalise($last);
            if ($norm !== '') {
                $rows[] = $norm;
            }
        }
        return $rows;
    }

    /**
     * True when every difference is only where the spaces fell — "ju stice" vs
     * "justice", "th enetherlands" vs "the netherlands", "marketdriven" vs
     * "market driven". Compared space-stripped, the two sides are the same words.
     *
     * @param list<array{from: string, to: string}> $substitutions
     */
    private function isSpacingOnly(array $substitutions): bool
    {
        foreach ($substitutions as $d) {
            if (str_replace(' ', '', $d['from']) !== str_replace(' ', '', $d['to'])) {
                return false;
            }
        }
        return $substitutions !== [];
    }

    private function namesReferenceList(string $text): bool
    {
        return (bool) preg_match('/\b(reference list|references|bibliography|works cited)\b/i', $text);
    }

    // -------------------------------------------------------------- analysis

    /** @return array{tokens: array<string,true>, joined: string} */
    private function indexWitness(string $text): array
    {
        $norm = GroundTruthText::normalise($text);
        $tokens = [];
        foreach (explode(' ', $norm) as $token) {
            if ($token !== '') {
                $tokens[$token] = true;
            }
        }
        return ['tokens' => $tokens, 'joined' => str_replace(' ', '', $norm)];
    }

    /**
     * Tokens present in the entry but absent from the witness in every
     * tolerated form. Absent from the document's own text layer => invented by
     * the converter.
     *
     * @param array{tokens: array<string,true>, joined: string} $witness
     * @return list<string>
     */
    private function inventedTokens(string $text, array $witness): array
    {
        $invented = [];
        foreach (array_unique(explode(' ', $text)) as $token) {
            if (mb_strlen($token) < self::MIN_TOKEN_LEN || ctype_digit($token)) {
                continue;
            }
            if (isset($witness['tokens'][$token])) {
                continue;
            }
            // A word the witness writes unsplit ("market driven" vs
            // "marketdriven") is a spacing artifact, not an invented word.
            if (str_contains($witness['joined'], $token)) {
                continue;
            }
            $singular = rtrim($token, 's');
            if (isset($witness['tokens'][$singular]) || isset($witness['tokens'][$token . 's'])) {
                continue;
            }
            $invented[] = $token;
        }
        return $invented;
    }

    /**
     * Best counterpart for an entry in the document's own reference list.
     *
     * Token-set overlap, not character similarity: two citations of the same
     * department differ in exactly the tokens that matter (title, year,
     * pinpoint) while sharing most characters, so character similarity picks
     * the wrong row and then "diffs" the real citation into fake corruption.
     *
     * @param list<string> $rows
     * @return array{0: ?string, 1: float}
     */
    private function bestReferenceRow(string $text, array $rows): array
    {
        $best = null;
        $bestScore = 0.0;
        foreach ($rows as $row) {
            $score = GroundTruthText::jaccard($text, $row);
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $row;
            }
        }
        return $bestScore >= self::WITNESS_MATCH_FLOOR ? [$best, $bestScore] : [null, $bestScore];
    }

    /**
     * Word-level diff (LCS) of entry text against witness text.
     *
     * @return list<array{from: string, to: string}>
     */
    private function wordDiff(string $a, string $b): array
    {
        $x = array_values(array_filter(explode(' ', $a), fn ($t) => $t !== ''));
        $y = array_values(array_filter(explode(' ', $b), fn ($t) => $t !== ''));
        $n = count($x);
        $m = count($y);

        // LCS table. Corpus entries are single citations (tens of words), so
        // the O(n*m) table is small.
        $lcs = array_fill(0, $n + 1, array_fill(0, $m + 1, 0));
        for ($i = $n - 1; $i >= 0; $i--) {
            for ($j = $m - 1; $j >= 0; $j--) {
                $lcs[$i][$j] = $x[$i] === $y[$j]
                    ? $lcs[$i + 1][$j + 1] + 1
                    : max($lcs[$i + 1][$j], $lcs[$i][$j + 1]);
            }
        }

        $diff = [];
        $from = [];
        $to = [];
        $i = 0;
        $j = 0;
        $flush = function () use (&$diff, &$from, &$to) {
            if ($from !== [] || $to !== []) {
                $diff[] = ['from' => implode(' ', $from), 'to' => implode(' ', $to)];
                $from = [];
                $to = [];
            }
        };
        while ($i < $n && $j < $m) {
            if ($x[$i] === $y[$j]) {
                $flush();
                $i++;
                $j++;
            } elseif ($lcs[$i + 1][$j] >= $lcs[$i][$j + 1]) {
                $from[] = $x[$i++];
            } else {
                $to[] = $y[$j++];
            }
        }
        while ($i < $n) {
            $from[] = $x[$i++];
        }
        while ($j < $m) {
            $to[] = $y[$j++];
        }
        $flush();

        return $diff;
    }
}
