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

        expect($md)->not->toContain('Year mismatch');
        expect($md)->not->toContain('Author mismatch');
        expect($md)->not->toContain('Title differs');
        expect($md)->toContain('cites 2 works');
        expect($md)->toContain('2nd');
        expect($md)->toContain('Thinking is Bad'); // the unchecked Panko work, named
        expect($md)->toContain('(2008)');
        expect($md)->toContain('checked against the matched work only');
    });
});

test('mismatch warnings still fire when the source matches NO cited work', function () {
    withCoverageBook(function (CitationReviewService $svc, string $book) {
        $claims = [
            ['referenceId' => 'r1', 'node_id' => 'n1', 'truth_claim' => 'Wrong match claim.',
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

        expect($md)->toContain('Year mismatch');
        expect($md)->toContain('Author mismatch');
        expect($md)->toContain('Title differs');
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
