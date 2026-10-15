<?php

use App\Services\CitationReview\Support\SourceTypeClassifier;

test('type reads llm_metadata.type', function () {
    expect(SourceTypeClassifier::type(['llm_metadata' => ['type' => 'journal-article']]))->toBe('journal-article');
});

test('type falls back to unknown when metadata is missing', function () {
    expect(SourceTypeClassifier::type([]))->toBe('unknown');
    expect(SourceTypeClassifier::type(['llm_metadata' => null]))->toBe('unknown');
    expect(SourceTypeClassifier::type(['llm_metadata' => []]))->toBe('unknown');
});

test('works returns the primary plus sub_citations', function () {
    $claim = ['llm_metadata' => [
        'type' => 'report', 'title' => 'ANAO Report',
        'sub_citations' => [['type' => 'journal-article', 'title' => 'Carney Article']],
    ]];
    $works = SourceTypeClassifier::works($claim);
    expect($works)->toHaveCount(2);
    expect($works[0]['title'])->toBe('ANAO Report');
    expect($works[1]['title'])->toBe('Carney Article');
});

test('works excludes sub_citations the scan already matched', function () {
    $claim = ['llm_metadata' => [
        'type' => 'report', 'title' => 'ANAO Report',
        'sub_citations' => [
            ['type' => 'journal-article', 'title' => 'Found One', 'resolution' => ['status' => 'matched', 'book' => 'b1']],
            ['type' => 'journal-article', 'title' => 'Lost One', 'resolution' => ['status' => 'no_match']],
        ],
    ]];
    $titles = array_column(SourceTypeClassifier::works($claim), 'title');
    expect($titles)->toBe(['ANAO Report', 'Lost One']);
});

test('shouldBeIndexed is true only for a journal article', function () {
    expect(SourceTypeClassifier::shouldBeIndexed(['llm_metadata' => ['type' => 'journal-article']]))->toBeTrue();
});

test('shouldBeIndexed is true when a SUB-citation is a journal article', function () {
    // The masked-🚩 bug: "ANAO report; Carney journal article" was classified by
    // the primary alone, so the unfound journal article escaped the red flag.
    $claim = ['llm_metadata' => [
        'type' => 'report',
        'sub_citations' => [['type' => 'journal-article', 'title' => 'Carney Article']],
    ]];
    expect(SourceTypeClassifier::shouldBeIndexed($claim))->toBeTrue();
});

test('shouldBeIndexed is false for books, unknown and missing metadata', function () {
    expect(SourceTypeClassifier::shouldBeIndexed(['llm_metadata' => ['type' => 'book']]))->toBeFalse();
    expect(SourceTypeClassifier::shouldBeIndexed(['llm_metadata' => ['type' => 'website']]))->toBeFalse();
    expect(SourceTypeClassifier::shouldBeIndexed([]))->toBeFalse();
});

test('journalArticleTitles names the journal-article works', function () {
    $claim = ['llm_metadata' => [
        'type' => 'report', 'title' => 'ANAO Report',
        'sub_citations' => [['type' => 'journal-article', 'title' => 'Carney Article']],
    ]];
    expect(SourceTypeClassifier::journalArticleTitles($claim))->toBe(['Carney Article']);
});

test('label maps known types to human singular labels', function () {
    expect(SourceTypeClassifier::label('journal-article'))->toBe('journal article');
    expect(SourceTypeClassifier::label('book'))->toBe('book');
    expect(SourceTypeClassifier::label('book-chapter'))->toBe('book chapter');
    expect(SourceTypeClassifier::label('conference-paper'))->toBe('conference paper');
    expect(SourceTypeClassifier::label('thesis'))->toBe('thesis');
    expect(SourceTypeClassifier::label('report'))->toBe('report');
    expect(SourceTypeClassifier::label('news-article'))->toBe('news article');
    expect(SourceTypeClassifier::label('legislation'))->toBe('piece of legislation');
    expect(SourceTypeClassifier::label('case-law'))->toBe('court decision');
});

test('label falls back to "source" for unknown types', function () {
    expect(SourceTypeClassifier::label('podcast'))->toBe('source');
    expect(SourceTypeClassifier::label('unknown'))->toBe('source');
});

test('notFoundExplanation: lone journal article keeps the 🚩 fabrication warning', function () {
    $text = SourceTypeClassifier::notFoundExplanation(['llm_metadata' => ['type' => 'journal-article']]);
    expect($text)->toContain('🚩');
    expect($text)->toContain('formatted as a journal article');
    expect($text)->toContain('stronger warning sign');
});

test('notFoundExplanation: a report gets "absence is expected", not the academic-work hedge', function () {
    $text = SourceTypeClassifier::notFoundExplanation(['llm_metadata' => ['type' => 'report']]);
    expect($text)->toContain('report');
    expect($text)->toContain('absence there is expected');
    expect($text)->not->toContain('may be because it is not an academic work');
    expect($text)->not->toContain('🚩');
});

test('notFoundExplanation: a book gets the weak-signal academic note', function () {
    $text = SourceTypeClassifier::notFoundExplanation(['llm_metadata' => ['type' => 'book']]);
    expect($text)->toContain('sometimes legitimately unindexed');
    expect($text)->not->toContain('🚩');
});

test('notFoundExplanation: unknown type keeps the honest generic hedge', function () {
    foreach ([[], ['llm_metadata' => ['type' => 'other']]] as $claim) {
        $text = SourceTypeClassifier::notFoundExplanation($claim);
        expect($text)->toContain('may be because it is not an academic work');
        expect($text)->not->toContain('🚩');
    }
});

test('possiblyUnsplitMultiWork detects a semicolon-joined citation parsed as one work', function () {
    // The IIA case: two works in the raw text, but extraction returned a single 'website'.
    $claim = [
        'bib_citation' => '<p>Department of Finance (Cth), Risk Management Toolkit (Web Page, 2023) '
            . 'https://www.finance.gov.au/toolkit ; Institute of Internal Auditors, '
            . 'The IIA\'s Three Lines Model (Position Paper, July 2020).</p>',
        'llm_metadata' => ['type' => 'website', 'title' => 'Risk Management Toolkit'],
    ];
    expect(SourceTypeClassifier::possiblyUnsplitMultiWork($claim))->toBeTrue();

    $text = SourceTypeClassifier::notFoundExplanation($claim);
    expect($text)->toContain('more than one work');
    expect($text)->toContain('never searched');
});

test('possiblyUnsplitMultiWork stays quiet when a split entry\'s sub already MATCHED', function () {
    // The IIA regression: recovery split the entry, the sub matched — works()
    // excludes matched subs, which made the entry masquerade as single-work
    // and drew a bogus "never searched" warning about a found work.
    expect(SourceTypeClassifier::possiblyUnsplitMultiWork([
        'bib_citation' => '<p>Finance Toolkit (Web Page, 2023); IIA, Three Lines Model (Position Paper, July 2020).</p>',
        'llm_metadata' => ['type' => 'website', 'title' => 'Risk Management Toolkit', 'sub_citations' => [
            ['type' => 'report', 'title' => 'Three Lines Model', 'resolution' => ['status' => 'matched', 'book' => 'stub1']],
        ]],
    ]))->toBeFalse();
});

test('possiblyUnsplitMultiWork stays quiet for split, single-work and short-form entries', function () {
    // Already split — sub_citations present
    expect(SourceTypeClassifier::possiblyUnsplitMultiWork([
        'bib_citation' => '<p>A (2020); B, Long Enough Title Here (2021).</p>',
        'llm_metadata' => ['type' => 'report', 'title' => 'A', 'sub_citations' => [['type' => 'report', 'title' => 'B']]],
    ]))->toBeFalse();
    // Genuinely single work, no semicolon
    expect(SourceTypeClassifier::possiblyUnsplitMultiWork([
        'bib_citation' => '<p>Author, A Single Work (Publisher, 2020).</p>',
        'llm_metadata' => ['type' => 'book', 'title' => 'A Single Work'],
    ]))->toBeFalse();
    // Semicolon but trailing segment too short / no year (e.g. "; 2nd ed")
    expect(SourceTypeClassifier::possiblyUnsplitMultiWork([
        'bib_citation' => '<p>Author, A Work (2020); rev ed.</p>',
        'llm_metadata' => ['type' => 'book', 'title' => 'A Work'],
    ]))->toBeFalse();
    // Short-form types excluded
    expect(SourceTypeClassifier::possiblyUnsplitMultiWork([
        'bib_citation' => '<p>Ibid; see also Another Thing From 2020 With Length.</p>',
        'llm_metadata' => ['type' => 'ibid'],
    ]))->toBeFalse();
});

test('notFoundExplanation: multi-work entry assesses each work and 🚩s the journal sub', function () {
    // The prod case: ANAO report (primary) + Carney journal article (sub), both unfound.
    $claim = ['llm_metadata' => [
        'type' => 'report', 'title' => 'Administering Regulation: Achieving the Right Balance',
        'sub_citations' => [['type' => 'journal-article', 'title' => 'The Automation of Legal Reasoning in Welfare']],
    ]];
    $text = SourceTypeClassifier::notFoundExplanation($claim);
    expect($text)->toContain('cites 2 works');
    expect($text)->toContain('Administering Regulation');
    expect($text)->toContain('not expected in academic databases');
    expect($text)->toContain('The Automation of Legal Reasoning in Welfare');
    expect($text)->toContain('🚩');
    expect($text)->toContain('fabricated');
});

test('looksLegislative: instrument names yes, works ABOUT instruments no', function () {
    // The c06 shape: agency parsed as author, typed 'report' by the extraction.
    expect(SourceTypeClassifier::looksLegislative(
        'Social Security Administration (Non-Compliance) Determination 2018 (No 1) (Cth)'
    ))->toBeTrue();
    // Act with a trailing pinpoint — ends at the jurisdiction once stripped.
    expect(SourceTypeClassifier::looksLegislative(
        'Social Security (Administration) Act 1999 (Cth) pt 3 div 3AA'
    ))->toBeTrue();
    // A BOOK about legislation: subtitle separator refuses.
    expect(SourceTypeClassifier::looksLegislative(
        'The Human Rights Act 1998 (UK): A Commentary'
    ))->toBeFalse();
    // A work about an act that keeps going past the jurisdiction refuses.
    expect(SourceTypeClassifier::looksLegislative(
        'The Privacy Act 1988 (Cth) and Its Discontents'
    ))->toBeFalse();
    // No instrument word + year: the Social Security Guide stays a website.
    expect(SourceTypeClassifier::looksLegislative(
        'Social Security Guide (Version 1.329, 12 May 2025)'
    ))->toBeFalse();
    expect(SourceTypeClassifier::looksLegislative(null))->toBeFalse();

    // The extraction routinely CLIPS "(Cth)" off the title (the live c06 shape):
    // a "(No 1)" tail is accepted only when the raw citation attests the jurisdiction.
    $clipped = 'Social Security Administration (Non-Compliance) Determination 2018 (No 1)';
    $raw = 'See as examples, Social Security Administration (Non-Compliance) Determination 2018 (No 1) (Cth); …';
    expect(SourceTypeClassifier::looksLegislative($clipped, $raw))->toBeTrue();
    expect(SourceTypeClassifier::looksLegislative($clipped))->toBeFalse();
    expect(SourceTypeClassifier::looksLegislative($clipped, 'no jurisdiction anywhere'))->toBeFalse();
});

test('coerceLegislativeTypes uses the raw citation for jurisdiction the extraction clipped', function () {
    $out = SourceTypeClassifier::coerceLegislativeTypes(
        [
            'type' => 'report',
            'title' => 'Social Security Administration (Non-Compliance) Determination 2018 (No 1)',
            'authors' => ['Social Security Administration'],
        ],
        'See as examples, Social Security Administration (Non-Compliance) Determination 2018 (No 1) (Cth); Department of Social Services (Cth), Social Security Guide',
    );
    expect($out['type'])->toBe('legislation')->and($out['authors'])->toBeNull();
});

test('coerceLegislativeTypes repairs primary AND subs, drops the invented author, and is idempotent', function () {
    $meta = [
        'type' => 'report',
        'title' => 'Social Security Administration (Non-Compliance) Determination 2018 (No 1) (Cth)',
        'authors' => ['Social Security Administration'],
        'sub_citations' => [
            ['type' => 'website', 'title' => 'Social Security Guide (Version 1.329, 12 May 2025)', 'authors' => ['Department of Social Services (Cth)']],
            ['type' => 'report', 'title' => 'Social Security (Administration) Act 1999 (Cth) pt 3 div 3AA'],
        ],
    ];

    $out = SourceTypeClassifier::coerceLegislativeTypes($meta);

    expect($out['type'])->toBe('legislation')
        ->and($out['authors'])->toBeNull()
        // The Guide is NOT an instrument — untouched, author kept.
        ->and($out['sub_citations'][0]['type'])->toBe('website')
        ->and($out['sub_citations'][0]['authors'])->toBe(['Department of Social Services (Cth)'])
        ->and($out['sub_citations'][1]['type'])->toBe('legislation');

    // Idempotent, and an already-correct legislation row is untouched.
    expect(SourceTypeClassifier::coerceLegislativeTypes($out))->toBe($out);
    expect(SourceTypeClassifier::coerceLegislativeTypes(null))->toBeNull();
});
