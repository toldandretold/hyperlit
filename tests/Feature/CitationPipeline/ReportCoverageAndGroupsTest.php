<?php

/**
 * ReportBuilder regressions from the Deloitte TCF footnote-only report:
 * 1. Coverage donut said "Source Not Found: 0" while the body listed 79
 *    unverified claims — total_bibliography is 0 for footnote-only books and
 *    max() clamped the negative. The builder must fall back to unique_sources.
 * 2. Legislation / case-law citations were dumped into "Unknown Type" (the
 *    group list didn't know those types) with a banner implying they should
 *    have been in academic databases.
 * 3. Bare "> Ibid." entries gave the reader nothing to act on — linked short
 *    forms must render a "Refers to:" line from the substituted metadata.
 */

use App\Services\CitationReviewService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

function coverageDb()
{
    return DB::connection('pgsql_admin');
}

function withCoverageBook(callable $fn): void
{
    $book = 'covgrp_' . Str::random(8);
    coverageDb()->table('library')->insert([
        'book' => $book, 'title' => 'Coverage Test Book', 'visibility' => 'public', 'listed' => false,
        'raw_json' => '[]', 'timestamp' => 0, 'created_at' => now(), 'updated_at' => now(),
    ]);
    try {
        $fn(app(CitationReviewService::class), $book);
    } finally {
        coverageDb()->table('library')->where('book', $book)->delete();
    }
}

test('coverage donut falls back to unique sources when total_bibliography is zero', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = [
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'A.', 'verified_source' => true,
             'verification_tier' => 'canonical', 'source_book_id' => 'src1',
             'llm_verdict' => ['support' => 'confirmed']],
            ['referenceId' => 'r2', 'node_id' => 'n2', 'truth_claim' => 'B.'],
            ['referenceId' => 'r3', 'node_id' => 'n3', 'truth_claim' => 'C.'],
        ];
        // Old stats payload from a footnote-only book: total_bibliography SET to 0
        $stats = [
            'unique_sources' => 3, 'verified_sources' => 1, 'canonical_sources' => 1,
            'sources_with_content' => 0, 'total_bibliography' => 0,
            'citation_occurrences' => 3, 'nodes_with_citations' => 3,
        ];
        $md = $svc->buildMarkdownReport($claims, $book, 'Coverage Test Book', $stats);

        expect($md)->toContain('<tr><td>Source Not Found</td><td>2</td></tr>');
        expect($md)->toContain('## Source Coverage');
        expect($md)->not->toContain('Known Unknown Citations');
    });
});

test('legislation and case-law get their own groups with a legal-register banner', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = [
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'Statute claim.',
             'bib_citation' => '<p>Social Security (Administration) Act 1999 (Cth)</p>',
             'llm_metadata' => ['type' => 'legislation', 'title' => 'Social Security (Administration) Act 1999']],
            ['referenceId' => 'r2', 'node_id' => 'n2', 'truth_claim' => 'Case claim.',
             'bib_citation' => '<p>Minister for Immigration v SZMDS (2010) 240 CLR 611</p>',
             'llm_metadata' => ['type' => 'case-law', 'title' => 'Minister for Immigration v SZMDS']],
        ];
        $md = $svc->buildMarkdownReport($claims, $book, 'Coverage Test Book', []);

        expect($md)->toContain('## Legislation (1)');
        expect($md)->toContain('## Case Law (1)');
        expect($md)->toContain('legal databases');
        expect($md)->not->toContain('## Unknown Type');
    });
});

test('a match to the work AFTER the semicolon reports which work matched, not phantom mismatches', function () {
    // The Deloitte Panko/Csernoch case: "Panko 2008; Csernoch 2024" in one
    // footnote — the DOI regex matched Csernoch, but the diagnostics compared
    // the source against the PRIMARY (Panko) and warned year/author/title
    // mismatch on a perfectly correct match.
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = [
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'Error rates claim.',
             'bib_citation' => '<p>Panko 2008; Csernoch 2024.</p>',
             'source_book_id' => 'src1', 'match_method' => 'doi', 'match_score' => 1.0,
             'source_title' => 'Modification of Erroneous and Correct Digital Texts',
             'source_author' => 'Mária Csernoch; Carolin Hannusch; Piroska Biró',
             'source_year' => 2024,
             'llm_metadata' => [
                 'type' => 'journal-article', 'year' => 2008,
                 'title' => 'Thinking is Bad: Implications of Human Error Research for Spreadsheet Research and Practice',
                 'authors' => ['Panko, Raymond'],
                 'sub_citations' => [[
                     'type' => 'journal-article', 'year' => 2024,
                     'title' => 'Modification of Erroneous and Correct Digital Texts',
                     'authors' => ['Csernoch, Maria', 'Hannusch, Carolin', 'Piroska, Biro'],
                 ]],
             ],
             'llm_verdict' => ['support' => 'unlikely', 'summary' => 'Not in this source.']],
        ];
        $md = $svc->buildMarkdownReport($claims, $book, 'Coverage Test Book', []);

        // A broken citation renders as a DIAGNOSIS, never a claim verification: the citation
        // as printed, the record it resolved to, and what to do — with NO verdict shown (the
        // legacy 'unlikely' is deliberately suppressed) and no apology about our matching.
        expect($md)->toContain('# Broken Sources (1)')
            ->toContain('Citation as printed')
            ->toContain('Thinking is Bad')                                   // the cited work, named
            ->toContain('Record this citation resolved to')
            ->toContain('Modification of Erroneous and Correct Digital Texts')
            ->toContain('This citation names 2 works')
            ->toContain('No verdict is issued');
        expect($md)->not->toContain('**Verdict:**')
            ->not->toContain('Year mismatch')
            ->not->toContain('Author mismatch')
            ->not->toContain('Title differs')
            ->not->toContain('checked against the matched work only')
            ->not->toContain('we matched');
    });
});

test('a source matching NO cited work is diagnosed as broken, not annotated with warnings', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = [
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'Wrong match claim.',
             'bib_citation' => '<p>Panko, Thinking is Bad (2008); Csernoch 2024.</p>',
             'source_book_id' => 'src1', 'match_method' => 'openalex', 'match_score' => 0.5,
             'source_title' => 'A Completely Different Work',
             'source_author' => 'Nobody, Else',
             'source_year' => 1999,
             'llm_metadata' => [
                 'type' => 'journal-article', 'year' => 2008,
                 'title' => 'Thinking is Bad', 'authors' => ['Panko, Raymond'],
                 'sub_citations' => [[
                     'type' => 'journal-article', 'year' => 2024,
                     'title' => 'Modification of Erroneous Texts', 'authors' => ['Csernoch, Maria'],
                 ]],
             ],
             'llm_verdict' => ['support' => 'unlikely', 'summary' => 'x']],
        ];
        $md = $svc->buildMarkdownReport($claims, $book, 'Coverage Test Book', []);

        // Diagnosed in its own section — not annotated with Year/Author/Title warnings inside
        // a claim block whose verdict is void anyway, and with no verdict rendered at all.
        expect($md)->toContain('# Broken Sources (1)')
            ->toContain('closest database match');
        expect($md)->not->toContain('Year mismatch')
            ->not->toContain('Author mismatch')
            ->not->toContain('Title differs')
            ->not->toContain('**Verdict:**');
        expect($md)->not->toContain('cites 2 works');
    });
});

test('an unfound multi-work entry lists every cited work even without a journal flag', function () {
    // Vanstone media release + Perkins report in one footnote: no journal
    // article, so no 🚩 — but the report must still say it's 2 works, not one.
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = [
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'PSP claim.',
             'bib_citation' => '<p>Vanstone, Launch of the PSP (2002); Perkins, Making it Work (2007).</p>',
             'llm_metadata' => [
                 'type' => 'other', 'title' => 'Launch of the Personal Support Programme',
                 'sub_citations' => [[
                     'type' => 'report', 'title' => 'Making it Work',
                 ]],
             ]],
        ];
        $md = $svc->buildMarkdownReport($claims, $book, 'Coverage Test Book', []);

        expect($md)->toContain('This entry cites 2 works:');
        expect($md)->toContain('Launch of the Personal Support Programme');
        expect($md)->toContain('Making it Work');
        expect($md)->toContain('— report');
        expect($md)->not->toContain('🚩');
    });
});

test('an unsplit multi-work citation is flagged in the report', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = [
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'Three lines claim.',
             'bib_citation' => '<p>Department of Finance (Cth), Risk Management Toolkit (Web Page, 2023) '
                 . 'https://www.finance.gov.au/toolkit ; Institute of Internal Auditors, '
                 . 'The IIA Three Lines Model (Position Paper, July 2020).</p>',
             'llm_metadata' => ['type' => 'website', 'title' => 'Risk Management Toolkit']],
        ];
        $md = $svc->buildMarkdownReport($claims, $book, 'Coverage Test Book', []);

        expect($md)->toContain('more than one work');
        expect($md)->toContain('never searched');
    });
});

test('a linked ibid claim renders a Refers to line in the report', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = [
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'Ibid claim.',
             'bib_citation' => '<p>Ibid.</p>',
             'llm_metadata' => [
                 'type' => 'journal-article', 'title' => 'Automating Compliance',
                 'authors' => ['Carney, Terry'], 'year' => 2024,
                 'short_form_of' => 'fn_full_1',
             ]],
        ];
        $md = $svc->buildMarkdownReport($claims, $book, 'Coverage Test Book', []);

        expect($md)->toContain('Refers to:');
        expect($md)->toContain('Carney, Terry');
        expect($md)->toContain('(2024)');
    });
});

/**
 * A wrong DOI is a finding about the CITATION, and it has to outrank the verdict in the report.
 *
 * The resolver flags it (CitationScanBibliographyJob::doiRecordDivergence) but the report sorts
 * claims by LLM verdict — so if the paper the bad DOI named happened to SUPPORT the claim, the
 * entry lands under "Confirmed" at the very bottom, and the reader has no reason to look. The
 * real cases, measured over 80 DOI resolutions in the study corpora: "Scientists split on ethics
 * of AI use" (2023) resolved to "Is it OK for AI to write science papers?" (2025), and "Thinking
 * is Bad: Implications of Human Error Research" (2008) to "Modification of Erroneous and Correct
 * Digital Texts" (2024).
 */
function doiMismatchClaim(string $refId, string $verdict = 'confirmed'): array
{
    return [
        'referenceId' => $refId, 'node_id' => 'n_' . $refId, 'truth_claim' => 'A claim.',
        'bib_citation' => '<p>Scientists split on ethics of ai use, Nature (2023). doi:10.1038/x</p>',
        'source_book_id' => 'src_' . $refId, 'verified_source' => true,
        'source_title' => 'Is it OK for AI to write science papers? Nature survey shows',
        'source_year' => 2025,
        'match_method' => 'doi', 'match_score' => 1.0,
        'llm_metadata' => ['title' => 'Scientists split on ethics of ai use', 'year' => 2023],
        'llm_verdict' => ['support' => $verdict],
        
    ];
}

test('a wrong source leads the report, ABOVE the verdict sections', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        // Verdict 'confirmed' on purpose: the worst case is the bad DOI's paper agreeing with the
        // claim, which buries the entry at the bottom under the old ordering.
        $md = $svc->buildMarkdownReport([doiMismatchClaim('r1')], $book, 'Coverage Test Book', []);

        expect($md)->toContain("# Broken Sources (1)")
            ->toContain('Scientists split on ethics of ai use')
            ->toContain('Is it OK for AI to write science papers?');
        // It LEADS: the section appears before any verdict section.
        expect(strpos($md, "# Broken Sources"))
            ->toBeLessThan(strpos($md, '# Confirmed') ?: PHP_INT_MAX);
    });
});

test('the diagnosis lays out the components and names the cause — never a verdict', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $md = $svc->buildMarkdownReport([doiMismatchClaim('r1')], $book, 'Coverage Test Book', []);

        // Component by component: identifier as printed, the record it resolves to, and how far
        // apart the two are — the reader should never have to guess what "Source:" means.
        expect($md)->toContain('Identifier printed in the citation')
            ->toContain('Record this citation resolved to')
            ->toContain('Title agreement')
            ->toContain('The identifier resolves to the record above, which is a different work')
            ->toContain('No verdict is issued');
        // A verdict for a broken citation must not render — the fixture's legacy 'confirmed'
        // (the worst case: the wrong paper agreeing) is deliberately suppressed.
        expect($md)->not->toContain('**Verdict:**')
            ->not->toContain('Title differs');
    });
});

test('one broken citation with five claims is ONE diagnosis, counting its impact', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = array_map(fn ($i) => doiMismatchClaim('r1') + ['node_id' => "n{$i}"], range(1, 5));
        $md = $svc->buildMarkdownReport($claims, $book, 'Coverage Test Book', []);

        // The unit the reader has to FIX is the citation, not the claim — one bad DOI is one
        // repair job however many sentences cite it. The impact line carries the claim count.
        expect($md)->toContain('# Broken Sources (1)')
            ->toContain('5 claims in the text cite this work')
            ->and(substr_count($md, 'Citation as printed'))->toBe(1);
    });
});

test('no mismatches means no section at all', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $md = $svc->buildMarkdownReport([
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'A.', 'source_book_id' => 'src1',
             'llm_verdict' => ['support' => 'confirmed']],
        ], $book, 'Coverage Test Book', []);

        // No cited title and no matched title — nothing to compare, and silence is not
        // disagreement. The summary table still carries the row (at 0); the SECTION does not exist.
        expect($md)->not->toContain("# Broken Sources");
    });
});

test('a run that PREDATES the flag still surfaces the wrong DOI — no re-scan needed', function () {
    // The flag is written at resolve time, so every existing claims file lacks it. The report
    // holds both titles already, so it derives the finding rather than making the reader pay for
    // a full re-scan to see it.
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claim = doiMismatchClaim('r1');
        unset($claim['match_diagnostics']);          // as an older run wrote it
        $md = $svc->buildMarkdownReport([$claim], $book, 'Coverage Test Book', []);

        expect($md)->toContain("# Broken Sources (1)")
            ->toContain('Is it OK for AI to write science papers?');
    });
});

test('the derived check agrees with the resolver: a formatting variant is NOT flagged', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $md = $svc->buildMarkdownReport([[
            'referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'A.',
            'source_book_id' => 'src1', 'match_method' => 'doi',
            'source_title' => 'MarketizingHindutva: The state, society, and markets in Hindu nationalism',
            'llm_metadata' => ['title' => 'Marketizing Hindutva: The state, society, and markets in Hindu nationalism'],
            'llm_verdict' => ['support' => 'confirmed'],
        ]], $book, 'Coverage Test Book', []);

        expect($md)->not->toContain("# Broken Sources");
    });
});

test('a title-SEARCH mismatch names the matcher, not the identifier', function () {
    // Same divergence, different cause: after a title search the matcher reached, which is the
    // inline "Title differs" warning — not "the identifier is wrong".
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $md = $svc->buildMarkdownReport([[
            'referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'A.',
            'source_book_id' => 'src1', 'match_method' => 'openalex',
            'source_title' => 'Something Entirely Unrelated',
            'llm_metadata' => ['title' => 'Scientists split on ethics of ai use'],
            'llm_verdict' => ['support' => 'confirmed'],
        ]], $book, 'Coverage Test Book', []);

        // The diagnosis names the MATCHER's reach, not a nonexistent identifier.
        expect($md)->toContain('closest database match')
            ->toContain('via openalex')
            ->and($md)->not->toContain('The identifier resolves to the record above');
    });
});

test('a pre-2026-09-21 local-DOI claim is caught by its source_doi, not its null match_method', function () {
    // Wave 2a never PERSISTED match_method, so every claim it resolved reads as method-less while
    // plainly being a DOI match. This is the live phase2 case: peer-review-2027-pdf resolves
    // "Scientists split on ethics of AI use" to a different Nature article, verdict `likely` —
    // which sorts it two thirds of the way down the report.
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $md = $svc->buildMarkdownReport([[
            'referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'A.',
            'source_book_id' => 'src1', 'match_method' => null,
            'source_doi' => '10.1038/d41586-025-01463-8',
            'source_title' => 'Is it OK for AI to write science papers? Nature survey shows',
            'llm_metadata' => ['title' => 'Scientists split on ethics of ai use'],
            'llm_verdict' => ['support' => 'likely'],
        ]], $book, 'Coverage Test Book', []);

        expect($md)->toContain("# Broken Sources (1)");
    });
});

test('a method-less claim with no identifier is attributed to the matcher', function () {
    // The detector covers every way we can end up on the wrong work, not only a bad DOI — so a
    // method-less title match still gets flagged, with the cause pointed at the matcher rather
    // than at an identifier that does not exist.
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $md = $svc->buildMarkdownReport([[
            'referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'A.',
            'source_book_id' => 'src1', 'match_method' => null,
            'source_title' => 'Something Entirely Unrelated',
            'llm_metadata' => ['title' => 'Scientists split on ethics of ai use'],
            'llm_verdict' => ['support' => 'confirmed'],
        ]], $book, 'Coverage Test Book', []);

        expect($md)->toContain("# Broken Sources (1)")
            ->and($md)->toContain('closest database match');
    });
});
