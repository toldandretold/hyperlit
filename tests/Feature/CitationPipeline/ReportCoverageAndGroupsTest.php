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
