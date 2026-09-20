<?php

use App\Services\CitationReview\Support\AnaphoraDetector;

/**
 * Which rescued claims need a contextualisation request, decided for free.
 *
 * The asymmetry that sets the bias: a FALSE POSITIVE costs one cheap LLM call, a FALSE NEGATIVE
 * sends an unresolvable claim to verification and yields a verdict about our own text rather than
 * about the citation. So the detector is deliberately over-inclusive, and these tests encode that
 * rather than treating over-inclusion as a bug.
 */
beforeEach(function () {
    $this->detector = new AnaphoraDetector();
});

it('says NO for a sentence that is already self-contained', function () {
    // Real text from chacko-2025-paste. Nothing points outside the sentence, so paying to rewrite
    // it would be pure waste — this is the common case and the reason the filter exists.
    expect($this->detector->needsContextualisation(
        'Despite these efforts, net inflows of FDI have fallen from 2.4% of GDP in 2020 to 0.8% in 2023.'
    ))->toBeTrue(); // "these efforts" DOES point outside — see the next case for a clean one

    expect($this->detector->needsContextualisation(
        'Net inflows of foreign direct investment fell from 2.4% of GDP in 2020 to 0.8% of GDP in 2023.'
    ))->toBeFalse();
});

it('says YES for a comparative reference to an earlier argument', function () {
    foreach ([
        'The same argument is made by Prebisch in his later work on dependency.',
        'A similar conclusion is reached about the collapse of the commodity agreements.',
        'Likewise, the developing-country coalition lost its bargaining leverage entirely.',
        'The former approach treats trade preferences as a temporary concession only.',
    ] as $claim) {
        expect($this->detector->needsContextualisation($claim))->toBeTrue($claim);
    }
});

it('says YES for pronouns and demonstratives standing in for the subject', function () {
    foreach ([
        'This was the central demand of the developing-country coalition throughout.',
        'They argued that commodity prices should be indexed to manufactured goods.',
        'Such conditions made the agreement unworkable for the poorest participants.',
        'It marked the end of the coalition as an effective bargaining bloc entirely.',
    ] as $claim) {
        expect($this->detector->needsContextualisation($claim))->toBeTrue($claim);
    }
});

it('says YES for a sentence that OPENS on a connective, even with no pronoun', function () {
    // The case a pronoun scan alone misses: the subject is grammatically present but the sentence
    // is continuing a thought, so the claim is only checkable against what came before. Real text
    // from nicholls-nieo-paste.
    expect($this->detector->needsContextualisation(
        'Instead, G77 solidarity crumbled amidst the so-called Third World Debt Crisis.'
    ))->toBeTrue();

    expect($this->detector->needsContextualisation(
        'However, the negotiations collapsed before any binding commitments were agreed.'
    ))->toBeTrue();
});

it('says YES for a short fragment, because a footnote span is a CLAUSE by design', function () {
    // precedingClauseSpan deliberately returns a clause, not a sentence, so footnote-sourced spans
    // are frequently fragments that cannot stand alone.
    expect($this->detector->needsContextualisation('because journal publication is critical'))->toBeTrue();
    expect($this->detector->needsContextualisation('Embargoes frustrate researchers,'))->toBeTrue();
});

it('does not fire on a word that merely CONTAINS a marker', function () {
    // Word-boundary matching: "itself", "thesis", "another" vs "other", "Italy" must not be read as
    // "it", "these", "another". A detector that fired on substrings would send everything.
    expect($this->detector->needsContextualisation(
        'Italian manufacturing output grew steadily across the whole of the reference period.'
    ))->toBeFalse();

    expect($this->detector->needsContextualisation(
        'Thesis committees at the university rejected the proposal on methodological grounds.'
    ))->toBeFalse();
});

it('says NO for empty input rather than requesting a rewrite of nothing', function () {
    expect($this->detector->needsContextualisation(null))->toBeFalse();
    expect($this->detector->needsContextualisation('   '))->toBeFalse();
});
