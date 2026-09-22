<?php

use App\Jobs\CitationScanBibliographyJob;
use App\Services\CitationReview\Support\SourceWorkMismatch;

/**
 * URL-FIRST for the LOCAL LIBRARY wave — the hole the rule was missing.
 *
 * The principle already existed for the external title-search waves (see YearCorroborationTest):
 * "a printed URL is itself a claim the author makes — this source exists, here — and assessing it
 * is part of what a citation review verifies". But Wave 3's local library search never goes
 * through `resolveWithNormalised()`, where that deferral lives. It matches an existing book by
 * title similarity and writes the columns itself, so it bypassed the gate entirely.
 *
 * The real case (nicholls-nieo-paste/c03, 2026-09-21, found BY THE USER reading the extracted
 * source): Sauvant's "The Early Days of the Group of 77" prints its own un.org address. A July
 * auto-version harvest of the same title matched at 0.9 in Wave 3 and consumed the reference, so
 * Wave 6 never fetched the URL — and that harvested book's stored "text" is 13,727 characters of
 * un.org navigation chrome. The reviewer was handed page furniture and reported the claim
 * unsupported, which reads as a verdict about the citation when it is a verdict about a harvest.
 * The author's own URL returns HTTP 200 and the right article.
 */
function deferLibrary(array $item, array $match): array
{
    $job = (new ReflectionClass(CitationScanBibliographyJob::class))->newInstanceWithoutConstructor();
    $m = new ReflectionMethod($job, 'deferLibraryMatchForPrintedUrl');
    $m->setAccessible(true);
    $deferred = $m->invoke($job, 'ref1', $item, $match);

    $prop = new ReflectionProperty($job, 'urlDeferredLibraryMatches');
    $prop->setAccessible(true);

    return ['deferred' => $deferred, 'stash' => $prop->getValue($job)];
}

/** A pool item as Wave 3 sees it. */
function poolItem(?string $printedUrl, string $content = 'Sauvant, Karl P. 2014. "The Early Days of the Group of 77."'): array
{
    return [
        'referenceId' => 'ref1',
        'isLinked' => false,
        'searchedTitle' => 'The Early Days of the Group of 77',
        'content' => $content,
        'llmMetadata' => ['year' => 2014, 'url' => $printedUrl],
    ];
}

test('the sauvant case DEFERS: a printed URL outranks an ungraded library match', function () {
    $out = deferLibrary(
        poolItem('https://www.un.org/en/chronicle/article/early-days-group-77'),
        ['book' => '6e813751', 'title' => 'The early days of the group of 77', 'score' => 0.9,
         'completeness' => null],
    );

    expect($out['deferred'])->toBeTrue()
        ->and($out['stash'])->toHaveKey('ref1')
        ->and($out['stash']['ref1']['match']['book'])->toBe('6e813751');
});

test('a URL printed in the citation TEXT defers too, not only an LLM-extracted one', function () {
    // extractUrl reads the reference as printed; llm_metadata.url is the fallback.
    $out = deferLibrary(
        poolItem(null, 'Sauvant 2014. The Early Days. https://www.un.org/en/chronicle/article/early-days-group-77'),
        ['book' => 'b1', 'title' => 'The early days', 'score' => 0.9, 'completeness' => null],
    );
    expect($out['deferred'])->toBeTrue();
});

test('NO printed URL means nothing to defer to — the library match stands', function () {
    $out = deferLibrary(
        poolItem(null, 'Sauvant, Karl P. 2014. The Early Days of the Group of 77.'),
        ['book' => 'b1', 'title' => 'The early days', 'score' => 0.9, 'completeness' => null],
    );
    expect($out['deferred'])->toBeFalse()
        ->and($out['stash'])->toBe([]);
});

test('a library copy KNOWN to carry the work is not traded for a web fetch', function () {
    // The protection against downgrading: only a positive completeness grade counts as evidence
    // that this copy IS the work. Deliberately not a character count — the case this rule exists
    // for holds 13,727 characters and every one of them is navigation.
    foreach (['verified_full', 'partial'] as $grade) {
        $out = deferLibrary(
            poolItem('https://www.un.org/en/chronicle/article/early-days-group-77'),
            ['book' => 'b1', 'title' => 'The early days', 'score' => 0.9, 'completeness' => $grade],
        );
        expect($out['deferred'])->toBeFalse("completeness={$grade} should stand");
    }
});

test('an UNVERIFIED copy still defers — unverified is not evidence', function () {
    $out = deferLibrary(
        poolItem('https://www.un.org/en/chronicle/article/early-days-group-77'),
        ['book' => 'b1', 'title' => 'The early days', 'score' => 0.9, 'completeness' => 'unverified'],
    );
    expect($out['deferred'])->toBeTrue();
});

test('a non-http printed value is not a URL to defer to', function () {
    $out = deferLibrary(
        poolItem('doi:10.18356/b2496076-en'),
        ['book' => 'b1', 'title' => 'The early days', 'score' => 0.9, 'completeness' => null],
    );
    expect($out['deferred'])->toBeFalse();
});

/**
 * The other half of the contract: deferral must never LOSE a resolution, and a weak read of the
 * URL must not evict the parked match. Both are expressed as constants/branches in the job; this
 * pins the grade bar so a future "usable text" refactor cannot quietly widen it.
 */
test('only grades that carry the ARTICLE beat a parked library match', function () {
    $bar = (new ReflectionClass(CitationScanBibliographyJob::class))
        ->getConstant('GRADES_CARRYING_ARTICLE_TEXT');

    expect($bar)->toBe(['full_text', 'article_extract', 'transcript']);
    // The ones deliberately EXCLUDED: a thin extract of a paywall teaser is technically usable
    // text (it is in WebTextAcquirer::USABLE_GRADES) and must not win.
    expect($bar)->not->toContain('thin_extract')
        ->and($bar)->not->toContain('metadata_only')
        ->and($bar)->not->toContain('paywalled');
});

/**
 * A DOI settles WHICH WORK — which is why it skips the title-search corroboration gate. But the
 * DOI is author-supplied (or extracted by us from OCR'd text), and nothing ever compared the
 * record it named against the citation that printed it.
 *
 * Measured over every DOI-resolved claim in the study corpora (80 distinct), 2 pulled an
 * unrelated work — and both are used verbatim below. Neither was visible anywhere: the claim
 * carried `tier: canonical`, and the reviewer judged against a paper the author never cited.
 */
function doiDivergence(?array $llmMeta, array $candidate): ?array
{
    // ONE definition, shared by the resolver, the report and the workbench — a threshold copied
    // three ways is how the console and the report end up disagreeing about the same citation.
    return SourceWorkMismatch::compare(
        $llmMeta['title'] ?? null,
        $candidate['title'] ?? null,
        isset($llmMeta['year']) ? (int) $llmMeta['year'] : null,
        isset($candidate['year']) ? (int) $candidate['year'] : null,
    );
}

test('the real wrong-work DOIs are FLAGGED', function () {
    expect(doiDivergence(
        ['title' => 'Scientists split on ethics of ai use', 'year' => 2023],
        ['title' => 'Is it OK for AI to write science papers? Nature survey shows', 'year' => 2025],
    ))->not->toBeNull();

    $flag = doiDivergence(
        ['title' => 'Thinking is Bad: Implications of Human Error Research for Spreadsheets', 'year' => 2008],
        ['title' => 'Modification of Erroneous and Correct Digital Texts', 'year' => 2024],
    );
    expect($flag)->not->toBeNull()
        ->and($flag['cited_year'])->toBe(2008)
        ->and($flag['matched_year'])->toBe(2024);
});

test('the same work with formatting differences is NOT flagged', function () {
    // The other side of the measurement: these are the SAME work and must resolve in silence.
    expect(doiDivergence(
        ['title' => 'Marketizing Hindutva: The state, society, and markets in Hindu nationalism'],
        ['title' => 'MarketizingHindutva: The state, society, and markets in Hindu nationalism'],
    ))->toBeNull();

    expect(doiDivergence(
        ['title' => 'Regcheck: A tool for automating comparisons between study registrations'],
        ['title' => 'RegCheck: A tool for structured comparisons between study registrations'],
    ))->toBeNull();

    expect(doiDivergence(
        ['title' => 'Abbreviations and acronyms in English word-formation'],
        ['title' => 'Abbreviations and Acronyms in English Word-Formation'],
    ))->toBeNull();
});

test('a missing title on either side is silence, not disagreement', function () {
    expect(doiDivergence(['title' => null], ['title' => 'Something']))->toBeNull()
        ->and(doiDivergence(['title' => 'Something'], ['title' => null]))->toBeNull()
        ->and(doiDivergence(null, ['title' => 'Something']))->toBeNull();
});

test('the flag DECLARES, it does not reject — both titles reach the reviewer', function () {
    $flag = doiDivergence(
        ['title' => 'Scientists split on ethics of ai use', 'year' => 2023],
        ['title' => 'Is it OK for AI to write science papers?', 'year' => 2025],
    );
    expect($flag['cited_title'])->toContain('Scientists split')
        ->and($flag['matched_title'])->toContain('Is it OK for AI')
        ->and($flag['overlap'])->toBeLessThan(0.35);
});

/**
 * forClaim's two ESCAPES, pinned with the three real phase2 single-work cases — because the
 * first version of this detector flagged all three, and only ONE is actually a broken citation.
 * A detector that cries wolf on a fine citation is telling a paying customer their reference is
 * suspect when nothing is wrong with it.
 */
test('THE ONE REAL BROKEN CITATION stays flagged: printed URL hosts a different article', function () {
    // chacko (Rajshekhar 2019a): the cited title is the 2019 Adani-bankruptcy Scroll piece, but
    // the URL printed in the citation is a DIFFERENT Scroll article (2024). We followed the URL —
    // correctly — and got what it hosts. The citation itself is broken.
    $flag = \App\Services\CitationReview\Support\SourceWorkMismatch::forClaim([
        'source_book_id' => 'web_x', 'match_method' => 'web_fetch',
        'bib_citation' => '<p>Rajshekhar M (2019a) Adani power project was on the brink of bankruptcy – but the '
            . 'BJP government in Gujarat saved it. Scroll, 6 March. Available at: '
            . 'https://scroll.in/article/1073452/modi-leads-adani-follows-is-indias-diplomacy-in-lockstep-'
            . 'with-a-private-firms-global-expansion</p>',
        'source_title' => "Modi leads, Adani follows: Is India's diplomacy in lockstep with a private group's global expansion?",
        'source_year' => 2024,
        'llm_metadata' => [
            'title' => 'Adani power project was on the brink of bankruptcy – but the BJP government in Gujarat saved it',
            'year' => 2019, 'authors' => ['Rajshekhar M'],
        ],
    ]);
    expect($flag)->not->toBeNull()
        ->and($flag['cause'])->toBe('title_search');
});

test('ESCAPE: a component of the cited work is NOT broken — the record title is IN the citation', function () {
    // Kissinger 1982: "What Dialogue?" is a titled section inside "Confronting the North-South
    // Dilemma", same DOI on both sides — the author wrote the container's title into the
    // citation. Verifying against the container is correct.
    expect(\App\Services\CitationReview\Support\SourceWorkMismatch::forClaim([
        'source_book_id' => 'b1', 'match_method' => null, 'source_doi' => '10.1080/01636608209477465',
        'bib_citation' => '<p>Kissinger, Henry. 1982. "What Dialogue?" in "Confronting the North-South Dilemma" '
            . 'by Robert Hormats and Henry Kissinger. The Washington Quarterly 5 (1): 153-154.</p>',
        'source_title' => 'Confronting the North-South Dilemma.', 'source_year' => 1982,
        'llm_metadata' => ['title' => 'What Dialogue?', 'year' => 1982,
            'doi' => '10.1080/01636608209477465', 'authors' => ['Kissinger, Henry']],
    ]))->toBeNull();
});

test('ESCAPE: print-vs-web headline of the SAME work is NOT broken, even with an OCR-mangled author', function () {
    // Kwon, Nature 641:574-577: print headline "Scientists split on ethics of AI use" vs web
    // headline at the SAME DOI, same year. OCR delivered the author as "G., G." — an unreadable
    // author is evidence-free, not contrary, and must not veto the DOI + year corroboration.
    expect(\App\Services\CitationReview\Support\SourceWorkMismatch::forClaim([
        'source_book_id' => 'b1', 'match_method' => null, 'source_doi' => '10.1038/d41586-025-01463-8',
        'bib_citation' => '<p>- G. G. (2023) Diana Kwon. Scientists split on ethics of ai use. Nature, '
            . '641:574–577, 2025. doi: 10.1038/d41586-025-01463-8.</p>',
        'source_title' => 'Is it OK for AI to write science papers? Nature survey shows researchers are split',
        'source_year' => '2025', 'source_author' => 'Diana Kwon',
        'llm_metadata' => ['title' => 'Scientists split on ethics of ai use', 'year' => 2025,
            'doi' => '10.1038/d41586-025-01463-8', 'authors' => ['G., G.']],
    ]))->toBeNull();
});

test('a readable author that DISAGREES still blocks the same-work escape', function () {
    // The counter-case the tri-state must not lose: same printed DOI, same year, but the record
    // names a different author entirely — that is a wrong record, not a headline variant.
    $flag = \App\Services\CitationReview\Support\SourceWorkMismatch::forClaim([
        'source_book_id' => 'b1', 'match_method' => null, 'source_doi' => '10.1038/x',
        'bib_citation' => '<p>Smith, John. Completely Original Title. Nature 2025. doi:10.1038/x</p>',
        'source_title' => 'An Entirely Unrelated Record Title Here',
        'source_year' => 2025, 'source_author' => 'Garcia, Maria',
        'llm_metadata' => ['title' => 'Completely Original Title', 'year' => 2025,
            'doi' => '10.1038/x', 'authors' => ['Smith, John']],
    ]);
    expect($flag)->not->toBeNull()
        ->and($flag['cause'])->toBe('identifier');
});
