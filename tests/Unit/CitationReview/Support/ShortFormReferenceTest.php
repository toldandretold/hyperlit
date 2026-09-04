<?php

use App\Services\CitationReview\Support\ShortFormReference;

test('describe renders the substituted antecedent work for a linked short form', function () {
    $claim = ['llm_metadata' => [
        'type' => 'journal-article', // substituted: the ANTECEDENT's type
        'title' => 'Automating Compliance and Administrative Justice',
        'authors' => ['Carney, Terry'],
        'year' => 2024,
        'short_form_of' => 'fn_full_1',
    ]];
    $text = ShortFormReference::describe($claim);
    expect($text)->toContain('Refers to:');
    expect($text)->toContain('Carney, Terry');
    expect($text)->toContain('Automating Compliance and Administrative Justice');
    expect($text)->toContain('(2024)');
});

test('describe explains an unlinked ibid honestly', function () {
    $claim = ['llm_metadata' => ['type' => 'ibid', 'title' => null, 'authors' => []]];
    expect(ShortFormReference::describe($claim))->toContain('could not be linked');
});

test('describe returns null for ordinary full citations and missing metadata', function () {
    expect(ShortFormReference::describe(['llm_metadata' => ['type' => 'journal-article', 'title' => 'X']]))->toBeNull();
    expect(ShortFormReference::describe([]))->toBeNull();
    expect(ShortFormReference::describe(['llm_metadata' => null]))->toBeNull();
});
