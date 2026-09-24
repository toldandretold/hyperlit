<?php

namespace App\Services\CitationStudy;

/**
 * "How many of our human ground-truth labels are backed by quotes from the source?"
 *
 * The study's weakest methodological point is the human baseline: a reviewer's
 * `verified_intact` is an assertion, and "we checked it by hand" is exactly the
 * claim a reader of the paper probes first. Evidence (short verbatim quotations
 * plus a locator) turns each into something showable, and this is the number
 * that says how far that has got.
 *
 * TWO THINGS DECIDE WHETHER THE NUMBER MEANS ANYTHING.
 *
 * The UNIT is the human ADJUDICATION, not the ground-truth entry. Entries carry
 * the manifest's blanket `default_label` — 2054 of 2066 across the corpora are
 * an auto `intact` nobody looked at — so an entry-based denominator would
 * report a coverage of ~0% forever and measure the corpus's size rather than
 * the reviewer's diligence.
 *
 * And the DENOMINATOR is the scored labels only. The non-scored ones
 * (`suspect`, `unverifiable`, `not_a_citation`) are exempt because there is
 * nothing to quote: you never obtained access, or no citation exists at all —
 * a phantom anchor the linker minted from a year range has no source to quote
 * FROM. Requiring evidence there would either park coverage permanently below
 * 100% or invite invented quotations. Those labels carry their reason in
 * `note` instead.
 */
class EvidenceCoverage
{
    public function __construct(private AdjudicationStore $adjudications) {}

    /**
     * Coverage across every book in a corpus.
     *
     * @return array{expected:int, evidenced:int, exempt:int, rate:?float,
     *               missing:list<array{slug:string, key:string, label:string}>,
     *               exempt_without_note:list<array{slug:string, key:string, label:string}>}
     */
    public function forCorpus(CorpusManifest $manifest): array
    {
        $expected = 0;
        $evidenced = 0;
        $exempt = 0;
        $missing = [];
        $exemptWithoutNote = [];
        $scored = AdjudicationStore::evidenceExpectedLabels();

        foreach ($manifest->books() as $book) {
            $records = $this->adjudications->load($manifest, $book)['adjudications'] ?? [];
            foreach ($records as $key => $record) {
                $label = (string) ($record['label'] ?? '');
                $slug = (string) $book['slug'];
                $row = [
                    'slug' => $slug,
                    'key' => (string) $key,
                    'label' => $label,
                    // Formatted once, here, so the report and the freeze warning
                    // name a citation identically. A gt_id already carries its
                    // slug ("fixture/c01"); a ref:-key does not.
                    'ref' => str_starts_with((string) $key, $slug . '/') ? (string) $key : $slug . '/' . $key,
                ];

                if (!in_array($label, $scored, true)) {
                    $exempt++;
                    // An exempt label still owes an explanation — "I could not
                    // get access" is itself the evidence for `unverifiable`.
                    if (trim((string) ($record['note'] ?? '')) === '') {
                        $exemptWithoutNote[] = $row;
                    }
                    continue;
                }

                $expected++;
                if (trim((string) ($record['evidence'] ?? '')) !== '') {
                    $evidenced++;
                } else {
                    $missing[] = $row;
                }
            }
        }

        return [
            'expected' => $expected,
            'evidenced' => $evidenced,
            'exempt' => $exempt,
            // Null rather than 1.0 when nothing is expected: "100% evidenced"
            // off zero adjudications reads as a result when it is an absence.
            'rate' => $expected > 0 ? round($evidenced / $expected, 4) : null,
            'missing' => $missing,
            'exempt_without_note' => $exemptWithoutNote,
        ];
    }

    /** One-line readout for a console command. */
    public static function summaryLine(array $coverage): string
    {
        if (($coverage['expected'] ?? 0) === 0) {
            return sprintf(
                'Evidence coverage: no scored human labels yet (%d exempt).',
                $coverage['exempt'] ?? 0,
            );
        }

        return sprintf(
            'Evidence coverage: %d of %d scored human labels evidenced (%s%%), %d exempt.',
            $coverage['evidenced'],
            $coverage['expected'],
            number_format(((float) $coverage['rate']) * 100, 1),
            $coverage['exempt'],
        );
    }
}
