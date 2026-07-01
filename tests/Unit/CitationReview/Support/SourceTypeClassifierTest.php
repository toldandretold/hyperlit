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

test('shouldBeIndexed is true only for a journal article', function () {
    expect(SourceTypeClassifier::shouldBeIndexed(['llm_metadata' => ['type' => 'journal-article']]))->toBeTrue();
});

test('shouldBeIndexed is false for books, unknown and missing metadata', function () {
    expect(SourceTypeClassifier::shouldBeIndexed(['llm_metadata' => ['type' => 'book']]))->toBeFalse();
    expect(SourceTypeClassifier::shouldBeIndexed(['llm_metadata' => ['type' => 'website']]))->toBeFalse();
    expect(SourceTypeClassifier::shouldBeIndexed([]))->toBeFalse();
});

test('label maps known types to human singular labels', function () {
    expect(SourceTypeClassifier::label('journal-article'))->toBe('journal article');
    expect(SourceTypeClassifier::label('book'))->toBe('book');
    expect(SourceTypeClassifier::label('book-chapter'))->toBe('book chapter');
    expect(SourceTypeClassifier::label('conference-paper'))->toBe('conference paper');
    expect(SourceTypeClassifier::label('thesis'))->toBe('thesis');
    expect(SourceTypeClassifier::label('report'))->toBe('report');
});

test('label falls back to "source" for unknown types', function () {
    expect(SourceTypeClassifier::label('podcast'))->toBe('source');
    expect(SourceTypeClassifier::label('unknown'))->toBe('source');
});
