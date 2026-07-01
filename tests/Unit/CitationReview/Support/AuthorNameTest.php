<?php

use App\Services\CitationReview\Support\AuthorName;

$a = fn() => new AuthorName();

test('surname-comma-first returns the surname', function () use ($a) {
    expect($a()->lastName('Piketty, Thomas'))->toBe('Piketty');
});

test('first-then-surname returns the last word', function () use ($a) {
    expect($a()->lastName('David Harvey'))->toBe('Harvey');
});

test('empty author returns empty string', function () use ($a) {
    expect($a()->lastName('  '))->toBe('');
});
