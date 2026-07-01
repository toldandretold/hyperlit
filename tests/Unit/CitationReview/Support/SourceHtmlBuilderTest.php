<?php

use App\Services\CitationReview\Support\SourceHtmlBuilder;
use App\Services\CitationReview\Support\SourceUrlResolver;

$b = fn() => new SourceHtmlBuilder(new SourceUrlResolver());

test('returns null when there is no source info', function () use ($b) {
    expect($b()->build([]))->toBeNull();
});

test('links the title in-app when content is available', function () use ($b) {
    $out = $b()->build([
        'source_title' => 'Capital',
        'source_author' => 'Piketty, Thomas',
        'source_year' => 2014,
        'has_source_content' => true,
        'source_book_id' => 'book_1/srcA',
    ]);
    expect($out['content'])->toContain('<a href="/book_1/srcA">Capital</a>');
    expect($out['content'])->toContain('Piketty, Thomas — (2014)');
    expect($out['plainText'])->toBe('Source: Capital — Piketty, Thomas — (2014)');
});

test('plain (unlinked) title when no in-app content', function () use ($b) {
    $out = $b()->build(['source_title' => 'Some Work']);
    expect($out['content'])->toBe('<p><strong>Source:</strong> Some Work</p>');
});

test('canonical tier appends the verified marker', function () use ($b) {
    $out = $b()->build(['source_title' => 'W', 'verification_tier' => 'canonical']);
    expect($out['content'])->toContain('✓ canonical-verified');
    expect($out['plainText'])->toContain('(canonical-verified)');
});
