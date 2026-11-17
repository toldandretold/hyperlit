<?php

/**
 * The work-mismatch flag exists to void verdicts given against the WRONG work — so its
 * escapes matter as much as its floor: a false mismatch sends the reviewer to "fix" a
 * resolution with nothing wrong in it. Pinned here are the two escapes that shipped
 * broken on deloitte 000b::sub1: a record whose URL IS the citation's printed URL
 * (identity settled by the author's own address), and the verbatim-title escape for
 * UNDATED works (requiring year agreement made it unreachable for every web page
 * citing no year — absence is silence, not disagreement).
 */

use App\Services\CitationReview\Support\SourceWorkMismatch;

function artClaim(array $overrides = []): array
{
    // deloitte 000b::sub1: cited "Centrelink" (ART web page, undated), resolved to the
    // stub minted from that very page — titled "Administrative Review Tribunal,
    // Centrelink", overlap 0.25, which sits under the floor.
    return array_merge([
        'source_book_id' => 'web_BdcRAd3QkFeUKQkhWrKE',
        'source_title'   => 'Administrative Review Tribunal, Centrelink',
        'source_url'     => 'https://www.art.gov.au/applying-review/centrelink',
        'bib_citation'   => 'Commonwealth Ombudsman, How to Make a Complaint (Web Page, 2024) '
            . 'https://www.ombudsman.gov.au/complaints/how-to-make-a-complaint; Administrative '
            . 'Review Tribunal, Centrelink (Web Page) https://www.art.gov.au/applying-review/centrelink.',
        'llm_metadata'   => [
            'title' => 'Centrelink',
            'url'   => 'https://www.art.gov.au/applying-review/centrelink',
        ],
    ], $overrides);
}

test('a record at the citation\'s own printed URL is the right work — no mismatch flag', function () {
    expect(SourceWorkMismatch::forClaim(artClaim()))->toBeNull();
});

test('URL normalisation: scheme, www and trailing slash never defeat the escape', function () {
    $claim = artClaim(['source_url' => 'http://art.gov.au/applying-review/centrelink/']);
    expect(SourceWorkMismatch::forClaim($claim))->toBeNull();
});

test('a DIFFERENT URL keeps the flag — the escape is identity, not leniency', function () {
    $claim = artClaim([
        'source_url'   => 'https://www.art.gov.au/about-us',
        // Kill escape 1 too: a record title NOT verbatim in the citation.
        'source_title' => 'Administrative Appeals Tribunal Annual Report',
    ]);
    $flag = SourceWorkMismatch::forClaim($claim);
    expect($flag)->not->toBeNull()
        ->and($flag['cause'])->toBe(SourceWorkMismatch::CAUSE_TITLE_SEARCH);
});

test('verbatim record title + both sides UNDATED escapes — absence of a year is not disagreement', function () {
    // No URLs at all: only escape 1 can clear this.
    $claim = artClaim(['source_url' => null]);
    $claim['llm_metadata']['url'] = null;
    expect(SourceWorkMismatch::forClaim($claim))->toBeNull();
});

test('verbatim record title with genuinely CONFLICTING years stays flagged', function () {
    $claim = artClaim(['source_url' => null, 'source_year' => 2009]);
    $claim['llm_metadata']['url'] = null;
    $claim['llm_metadata']['year'] = 2024;
    $flag = SourceWorkMismatch::forClaim($claim);
    expect($flag)->not->toBeNull();
});

test('a SCREENED-rejected page at the printed URL stays flagged — content outranks the address', function () {
    // The author printed an address whose page hosts a DIFFERENT work; the identity screen
    // already said so (web_status rejected). URL identity must not launder that.
    $claim = artClaim([
        'source_title' => 'Unrelated Landing Page',
        'web_status'   => 'rejected',
    ]);
    $claim['llm_metadata']['title'] = 'The Original Cited Study Title That Is Quite Different';
    expect(SourceWorkMismatch::forClaim($claim))->not->toBeNull();
});
